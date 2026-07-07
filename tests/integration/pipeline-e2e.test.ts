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
import { runCurate } from '../../src/curate/run-curate.ts';
import type { Translator } from '../../src/enrich/translator.ts';
import { LocalOnnxEmbedder } from '../../src/index/embedders/local-onnx.ts';
import { search, searchByEntity } from '../../src/index/query.ts';
import { runIndex } from '../../src/index/run-index.ts';
import { openDb } from '../../src/store/db.ts';
import { runMigrations } from '../../src/store/migrate.ts';
import { EntitiesRepo } from '../../src/store/repos/entities.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIX = fileURLToPath(new URL('../fixtures/portal/', import.meta.url));

// standard.json: dataset 00000000-...0001, title "Първи набор от данни", org "Столична община",
// one CSV resource. We serve real CSV bytes for the resource so the curator emits a tabular artifact.
const DATASET_ID = '00000000-0000-0000-0000-000000000001';
const CSV = ['Пореден №,Община,Сума', '1,София,1000', '2,Пловдив,2000'].join('\n');

// A deterministic stand-in for a real BG→EN translator (the shipped local-marianmt is a 0.0-conf
// stub). It lets us assert the translation handoff reaches the index/search output.
const translator: Translator = {
  id: 'test:prefix',
  async translate(text: string) {
    return { text: `EN:${text}`, confidence: 0.9 };
  },
};

function makeConfig(storeRoot: string): DanniConfig {
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
    scope: {},
    enrichment: {
      translator: { provider: 'local-marianmt' },
      embedder: { provider: 'local-onnx', batchSize: 32 },
    },
    index: { incremental: true },
  } as DanniConfig;
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
        const d1 = JSON.parse(readFileSync(join(FIX, 'package_show/standard.json'), 'utf-8')) as {
          result: unknown;
        };
        return new Response(
          JSON.stringify({ help: '', success: true, result: { count: 1, results: [d1.result] } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ) as unknown as Response;
      }
      return new Response(
        JSON.stringify({ help: '', success: true, result: { count: 0, results: [] } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ) as unknown as Response;
    }
    if (url.includes('action/package_show')) {
      return new Response(readFileSync(join(FIX, 'package_show/standard.json'), 'utf-8'), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }) as unknown as Response;
    }
    // Any other URL is the resource download — serve the CSV bytes.
    return new Response(CSV, {
      status: 200,
      headers: { 'content-type': 'text/csv' },
    }) as unknown as Response;
  }) as unknown as typeof fetch;
}

function buildContext(cfg: DanniConfig) {
  const fetcher = makeFetcher();
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

// The only test that drives all five stages end to end (sync → curate → enrich → index → search)
// against the same on-disk store, so a contract drift between stages would fail here even though
// the per-stage suites pass in isolation.
describe('integration.pipeline-e2e (sync → curate → enrich → index → search)', () => {
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

  it('captures, curates, enriches, indexes and returns a traceable, readable search hit', async () => {
    const cfg = makeConfig(storeRoot);

    // 1 · SYNC — capture the dataset + its CSV resource into store/raw.
    const ctx = buildContext(cfg);
    const sync = await runSync({
      db,
      config: cfg,
      client: ctx.client,
      http: ctx.http,
      storeRoot,
      trigger: 'manual',
    });
    expect(sync.totals.discovered).toBe(1);
    expect(sync.totals.captured).toBeGreaterThanOrEqual(1);

    // 2+3 · CURATE + ENRICH — normalize the CSV and attach entities/translations.
    const curate = await runCurate({ db, storeRoot, curatorVersion: 'v1', translator });
    expect(curate.curated).toBeGreaterThanOrEqual(1);
    expect(curate.entitiesAttached).toBeGreaterThan(0);
    expect(curate.translationsWritten).toBeGreaterThan(0);

    // 4 · INDEX — build FTS + vectors over the curated mirror.
    const embedder = new LocalOnnxEmbedder({ dimension: 8 });
    const indexed = await runIndex({ db, embedder });
    expect(indexed.ftsUpdated).toBeGreaterThanOrEqual(1);

    // 5 · SEARCH — a keyword from the dataset title resolves back to a readable, traceable hit.
    const results = await search({ db, embedder, query: 'набор' });
    const hit = results.find((r) => r.datasetId === DATASET_ID);
    expect(hit).toBeDefined();
    if (!hit) return;
    // FR-013: one-hop traceability — source URL back to the portal, curated path readable on disk.
    expect(hit.sourceUrl).toContain('data.egov.bg');
    expect(existsSync(join(storeRoot, 'curated', hit.curatedDatasetPath))).toBe(true);
    // The injected translation flowed sync→curate→index→search.
    expect(hit.title.bg).toContain('набор');
    expect(hit.title.en).toBe('EN:Първи набор от данни');

    // Entity-anchored recall returns the dataset with a populated (non-degraded) entity label.
    const attachment = new EntitiesRepo(db).listAttachments(DATASET_ID)[0];
    expect(attachment).toBeDefined();
    if (!attachment) return;
    const byEntity = await searchByEntity({ db, embedder, query: '' }, attachment.entity_id);
    expect(byEntity.some((r) => r.datasetId === DATASET_ID)).toBe(true);
    const matched = byEntity[0]?.matchedEntities?.[0];
    expect(matched?.kind).not.toBe('unknown');
    expect((matched?.label.bg ?? '').length).toBeGreaterThan(0);
  });
});
