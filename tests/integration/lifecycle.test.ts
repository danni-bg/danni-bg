import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DanniConfig } from '../../src/config/schema.ts';
import { BackoffRunner } from '../../src/crawler/backoff.ts';
import { CkanClient } from '../../src/crawler/ckan-client.ts';
import { PortalHttp } from '../../src/crawler/http.ts';
import { RateLimiter } from '../../src/crawler/rate-limit.ts';
import { RobotsCache } from '../../src/crawler/robots.ts';
import { runSync } from '../../src/crawler/run-sync.ts';
import { openDb } from '../../src/store/db.ts';
import { runMigrations } from '../../src/store/migrate.ts';
import { DatasetsRepo } from '../../src/store/repos/datasets.ts';
import { ResourcesRepo } from '../../src/store/repos/resources.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIX = fileURLToPath(new URL('../fixtures/portal/', import.meta.url));

function makeConfig(storeRoot: string, scope: DanniConfig['scope'] = {}): DanniConfig {
  return {
    portal: { baseUrl: 'https://data.egov.bg/api/3/action/', api: 'ckan' },
    crawler: {
      userAgent: 'danni-bg/test (+local)',
      rateLimit: { requestsPerSecondPerHost: 100 },
      concurrency: { maxConcurrentRequestsPerHost: 4 },
      backoff: { initialMs: 10, maxMs: 100, failureBudget: 3 },
      robots: { recheckIntervalSeconds: 86400, obey: true, allowHosts: [] },
    },
    store: { root: storeRoot, freshnessSloSeconds: 86400 },
    schedule: {
      enabled: false,
      cron: null,
      onOverlap: 'skip',
      failureRateThreshold: 0.05,
      notifier: { kind: 'stderr' },
    },
    scope,
    enrichment: {
      translator: { provider: 'local-marianmt' },
      embedder: { provider: 'local-onnx', batchSize: 32 },
    },
    index: { incremental: true },
  };
}

interface FetcherState {
  showD1: boolean;
  showD2: boolean;
  resourceBytes: Buffer;
}

function makeFetcher(state: FetcherState): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/robots.txt')) {
      return new Response('User-agent: *\nAllow: /\n', { status: 200 }) as unknown as Response;
    }
    if (url.includes('action/package_search')) {
      const start = new URL(url).searchParams.get('start') ?? '0';
      if (start === '0') {
        const results: unknown[] = [];
        if (state.showD1) {
          const d1 = JSON.parse(readFileSync(join(FIX, 'package_show/standard.json'), 'utf-8')) as {
            result: unknown;
          };
          results.push(d1.result);
        }
        if (state.showD2) {
          const d2 = JSON.parse(readFileSync(join(FIX, 'package_show/cyrillic.json'), 'utf-8')) as {
            result: unknown;
          };
          results.push(d2.result);
        }
        return new Response(
          JSON.stringify({
            help: '',
            success: true,
            result: { count: results.length, results },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ) as unknown as Response;
      }
      return new Response(
        JSON.stringify({ help: '', success: true, result: { count: 0, results: [] } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ) as unknown as Response;
    }
    if (url.includes('action/package_show')) {
      const id = new URL(url).searchParams.get('id');
      if (id === '00000000-0000-0000-0000-000000000001') {
        return new Response(readFileSync(join(FIX, 'package_show/standard.json'), 'utf-8'), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }) as unknown as Response;
      }
      if (id === '00000000-0000-0000-0000-000000000002') {
        return new Response(readFileSync(join(FIX, 'package_show/cyrillic.json'), 'utf-8'), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }) as unknown as Response;
      }
    }
    return new Response(state.resourceBytes, {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    }) as unknown as Response;
  }) as unknown as typeof fetch;
}

function buildContext(fetcher: typeof fetch, cfg: DanniConfig) {
  const rateLimiter = new RateLimiter({
    requestsPerSecond: cfg.crawler.rateLimit.requestsPerSecondPerHost,
    concurrency: cfg.crawler.concurrency.maxConcurrentRequestsPerHost,
  });
  const backoff = new BackoffRunner({
    initialMs: cfg.crawler.backoff.initialMs,
    maxMs: cfg.crawler.backoff.maxMs,
    failureBudget: cfg.crawler.backoff.failureBudget,
    sleep: async () => undefined,
  });
  const robots = new RobotsCache({
    recheckIntervalSeconds: cfg.crawler.robots.recheckIntervalSeconds,
    fetcher: async (u) => {
      const r = await fetcher(u);
      return { status: r.status, body: await r.text() };
    },
  });
  const http = new PortalHttp({
    userAgent: cfg.crawler.userAgent,
    rateLimiter,
    backoff,
    robots,
    fetcher,
  });
  const client = new CkanClient({ baseUrl: cfg.portal.baseUrl, http });
  return { client, http };
}

describe('integration.lifecycle', () => {
  let db: Database;
  let storeRoot: string;
  beforeEach(() => {
    storeRoot = globalThis.__TEST_TMP_DIR__;
    db = openDb({ storeRoot, loadVec: false });
    runMigrations(db, join(ROOT, 'migrations'));
  });
  afterEach(() => {
    db.close();
  });

  it('records a withdrawn event when a dataset disappears from discovery', async () => {
    const cfg = makeConfig(storeRoot);
    const state: FetcherState = {
      showD1: true,
      showD2: true,
      resourceBytes: Buffer.from('hello'),
    };
    let ctx = buildContext(makeFetcher(state), cfg);
    const first = await runSync({
      db,
      config: cfg,
      client: ctx.client,
      http: ctx.http,
      storeRoot,
      trigger: 'manual',
    });
    expect(first.totals.discovered).toBe(2);

    state.showD2 = false;
    ctx = buildContext(makeFetcher(state), cfg);
    const second = await runSync({
      db,
      config: cfg,
      client: ctx.client,
      http: ctx.http,
      storeRoot,
      trigger: 'manual',
    });
    expect(second.totals.withdrawn).toBe(1);
    const d2 = new DatasetsRepo(db).get('00000000-0000-0000-0000-000000000002');
    expect(d2?.lifecycle_state).toBe('withdrawn');
    // Raw bytes preserved
    const r2 = new ResourcesRepo(db).listByDataset('00000000-0000-0000-0000-000000000002');
    for (const r of r2) {
      if (r.raw_path) {
        expect(existsSync(join(storeRoot, 'raw', r.raw_path))).toBe(true);
      }
    }
  });

  it('records out_of_scope when a narrowed scope filter excludes a dataset', async () => {
    const cfg = makeConfig(storeRoot);
    const state: FetcherState = {
      showD1: true,
      showD2: true,
      resourceBytes: Buffer.from('hello'),
    };
    let ctx = buildContext(makeFetcher(state), cfg);
    await runSync({
      db,
      config: cfg,
      client: ctx.client,
      http: ctx.http,
      storeRoot,
      trigger: 'manual',
    });

    // Narrow to cyrillic.json's tag — standard.json doesn't carry it. The
    // orchestrator marks the dropped dataset withdrawn (not yielded by discovery)
    // and preserves its rows + raw bytes either way (FR-018a).
    const cfgNarrow = makeConfig(storeRoot, { tags: ['кирилица'] });
    ctx = buildContext(makeFetcher(state), cfgNarrow);
    const second = await runSync({
      db,
      config: cfgNarrow,
      client: ctx.client,
      http: ctx.http,
      storeRoot,
      trigger: 'manual',
    });
    expect(second.totals.withdrawn + second.totals.outOfScope).toBeGreaterThanOrEqual(1);
    const d1 = new DatasetsRepo(db).get('00000000-0000-0000-0000-000000000001');
    expect(['out_of_scope', 'withdrawn']).toContain(d1?.lifecycle_state ?? '');
    // Raw rows preserved
    const r1 = new ResourcesRepo(db).listByDataset('00000000-0000-0000-0000-000000000001');
    expect(r1.length).toBeGreaterThan(0);
  });
});
