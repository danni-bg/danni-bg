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
      userAgent: 'danni-bg/9.9.9 (+https://example.test/contact)',
      rateLimit: { requestsPerSecondPerHost: 50 },
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

interface RecordedCall {
  url: string;
  headers: Record<string, string>;
}

function makeFetcher(record: RecordedCall[], denyResource = false): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit | undefined) => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    record.push({ url, headers });
    if (url.endsWith('/robots.txt')) {
      const body = denyResource
        ? 'User-agent: *\nDisallow: /private/\n'
        : 'User-agent: *\nAllow: /\n';
      return new Response(body, { status: 200 }) as unknown as Response;
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

describe('integration.respectful-crawler', () => {
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

  it('sends identifying User-Agent and conditional headers on second pass', async () => {
    const cfg = makeConfig(storeRoot);
    const calls: RecordedCall[] = [];
    let ctx = buildContext(makeFetcher(calls), cfg);
    await runSync({
      db,
      config: cfg,
      client: ctx.client,
      http: ctx.http,
      storeRoot,
      trigger: 'manual',
    });

    const uaRequests = calls.filter((c) => !c.url.endsWith('/robots.txt'));
    for (const c of uaRequests) {
      expect(c.headers['user-agent']).toContain('danni-bg/');
      expect(c.headers['user-agent']).toContain('+https://example.test/contact');
    }

    // Second pass — conditional fetch should attach if-none-match
    const calls2: RecordedCall[] = [];
    ctx = buildContext(makeFetcher(calls2), cfg);
    await runSync({
      db,
      config: cfg,
      client: ctx.client,
      http: ctx.http,
      storeRoot,
      trigger: 'manual',
    });
    const resourceCalls = calls2.filter(
      (c) => !c.url.includes('action/') && !c.url.endsWith('/robots.txt'),
    );
    expect(resourceCalls.length).toBeGreaterThan(0);
    for (const c of resourceCalls) {
      expect(c.headers['if-none-match']).toBe('"v1"');
    }
  });

  it('robots.txt is fetched at most once per host within the recheck window', async () => {
    const cfg = makeConfig(storeRoot);
    const calls: RecordedCall[] = [];
    const ctx = buildContext(makeFetcher(calls), cfg);
    await runSync({
      db,
      config: cfg,
      client: ctx.client,
      http: ctx.http,
      storeRoot,
      trigger: 'manual',
    });
    const robotsCalls = calls.filter((c) => c.url.endsWith('/robots.txt'));
    expect(robotsCalls.length).toBe(1);
  });
});
