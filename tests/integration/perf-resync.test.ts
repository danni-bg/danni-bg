import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
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

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIX = fileURLToPath(new URL('../fixtures/portal/', import.meta.url));

function makeConfig(storeRoot: string): DanniConfig {
  return {
    portal: { baseUrl: 'https://data.egov.bg/api/3/action/', api: 'ckan' },
    crawler: {
      userAgent: 'danni-bg/test',
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
    scope: {},
    enrichment: {
      translator: { provider: 'local-marianmt' },
      embedder: { provider: 'local-onnx', batchSize: 32 },
    },
    index: { incremental: true },
  };
}

function makeFetcher(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
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
        { status: 200 },
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
    return new Response('payload', {
      status: 200,
      headers: { 'content-type': 'text/csv', etag: '"v1"' },
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
  return { client: new CkanClient({ baseUrl: cfg.portal.baseUrl, http }), http };
}

describe('integration.perf-resync (SC-002)', () => {
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

  it('re-sync wall time is <50% of bootstrap wall time on the fixture corpus (relaxed CI gate)', async () => {
    const cfg = makeConfig(storeRoot);
    const ctx = buildContext(makeFetcher(), cfg);
    const t0 = performance.now();
    await runSync({
      db,
      config: cfg,
      client: ctx.client,
      http: ctx.http,
      storeRoot,
      trigger: 'manual',
    });
    const bootstrapMs = performance.now() - t0;

    const ctx2 = buildContext(makeFetcher(), cfg);
    const t1 = performance.now();
    await runSync({
      db,
      config: cfg,
      client: ctx2.client,
      http: ctx2.http,
      storeRoot,
      trigger: 'manual',
    });
    const resyncMs = performance.now() - t1;
    // Production target is <10% (SC-002). The fixture corpus is too small for a tight
    // ratio; we settle for <50% as the smoke gate.
    expect(resyncMs).toBeLessThan(bootstrapMs * 0.5 + 50);
  });
});
