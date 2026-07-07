import { describe, expect, it } from 'bun:test';
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
import { ResourcesRepo } from '../../src/store/repos/resources.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIX = fileURLToPath(new URL('../fixtures/portal/', import.meta.url));

function makeConfig(storeRoot: string): DanniConfig {
  return {
    portal: { baseUrl: 'https://data.egov.bg/api/3/action/', api: 'ckan' },
    crawler: {
      userAgent: 'danni-bg/test (+local)',
      rateLimit: { requestsPerSecondPerHost: 100 },
      concurrency: { maxConcurrentRequestsPerHost: 4 },
      backoff: { initialMs: 100, maxMs: 1000, failureBudget: 3 },
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
    scope: {},
    enrichment: {
      translator: { provider: 'local-marianmt' },
      embedder: { provider: 'local-onnx', batchSize: 32 },
    },
    index: { incremental: true },
  };
}

interface FetcherState {
  callsByUrl: Map<string, number>;
  resourceBytes: Buffer;
}

function makeFetcher(state: FetcherState, opts: { failResource?: boolean } = {}): typeof fetch {
  const f = async (input: string | URL | Request, init?: RequestInit | undefined) => {
    const url = typeof input === 'string' ? input : input.toString();
    state.callsByUrl.set(url, (state.callsByUrl.get(url) ?? 0) + 1);
    const reqHeaders = (init?.headers ?? {}) as Record<string, string>;
    const ifNoneMatch = reqHeaders['if-none-match'] ?? reqHeaders['If-None-Match'];
    if (url.endsWith('/robots.txt')) {
      return new Response('User-agent: *\nAllow: /\n', { status: 200 }) as unknown as Response;
    }
    if (url.includes('action/package_search')) {
      const start = new URL(url).searchParams.get('start') ?? '0';
      if (start === '0') {
        return new Response(readFileSync(join(FIX, 'package_search/page-1.json'), 'utf-8'), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }) as unknown as Response;
      }
      return new Response(
        JSON.stringify({ help: '', success: true, result: { count: 2, results: [] } }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
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
    if (url === 'https://data.egov.bg/files/budget-2025.csv') {
      if (opts.failResource) {
        return new Response('boom', { status: 500 }) as unknown as Response;
      }
      if (ifNoneMatch === '"abc"') {
        return new Response(null, {
          status: 304,
          headers: { etag: '"abc"' },
        }) as unknown as Response;
      }
      return new Response(state.resourceBytes, {
        status: 200,
        headers: {
          'content-type': 'text/csv',
          etag: '"abc"',
        },
      }) as unknown as Response;
    }
    return new Response('not found', { status: 404 }) as unknown as Response;
  };
  return f as unknown as typeof fetch;
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
  return (
    new CkanClient({ baseUrl: cfg.portal.baseUrl, http }) && {
      client: new CkanClient({ baseUrl: cfg.portal.baseUrl, http }),
      http,
    }
  );
}

describe('integration.sync.bootstrap-then-resync', () => {
  it('captures all resources fresh; second run skips unchanged content', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const db = openDb({ storeRoot, loadVec: false });
    runMigrations(db, join(ROOT, 'migrations'));

    const cfg = makeConfig(storeRoot);
    const state: FetcherState = {
      callsByUrl: new Map(),
      resourceBytes: Buffer.from('id,a\n1,2\n', 'utf-8'),
    };
    const ctx = buildContext(makeFetcher(state), cfg);

    const first = await runSync({
      db,
      config: cfg,
      client: ctx.client,
      http: ctx.http,
      storeRoot,
      trigger: 'manual',
    });
    expect(first.summaryOutcome).toBe('success');
    expect(first.totals.discovered).toBe(2);
    expect(first.totals.captured).toBe(1);
    expect(first.manifestPath).not.toBeNull();
    expect(existsSync(first.manifestPath as string)).toBe(true);

    // Second run with the same fixtures should be a no-op for resources
    const ctx2 = buildContext(makeFetcher(state), cfg);
    const second = await runSync({
      db,
      config: cfg,
      client: ctx2.client,
      http: ctx2.http,
      storeRoot,
      trigger: 'manual',
    });
    expect(second.summaryOutcome).toBe('success');
    expect(second.totals.captured).toBe(0);
    expect(second.totals.skippedUnchanged + second.totals.captured).toBeGreaterThanOrEqual(1);

    // The blob is still on disk
    const repo = new ResourcesRepo(db);
    const r = repo.get('aaaa1111-aaaa-1111-aaaa-111111111111');
    expect(r?.sha256).not.toBeNull();
    expect(r?.bytes).toBeGreaterThan(0);

    db.close();
  });

  it('reports exit-3-equivalent (partial outcome) when one resource fails', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const db = openDb({ storeRoot, loadVec: false });
    runMigrations(db, join(ROOT, 'migrations'));

    const cfg = makeConfig(storeRoot);
    const state: FetcherState = { callsByUrl: new Map(), resourceBytes: Buffer.from('x') };
    const ctx = buildContext(makeFetcher(state, { failResource: true }), cfg);

    const result = await runSync({
      db,
      config: cfg,
      client: ctx.client,
      http: ctx.http,
      storeRoot,
      trigger: 'manual',
    });
    expect(result.summaryOutcome).toBe('failed');
    expect(result.totals.failed).toBe(1);
    expect(result.totals.captured).toBe(0);
    db.close();
  });
});
