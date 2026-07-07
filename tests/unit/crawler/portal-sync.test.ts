import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type DanniConfig, DanniConfigSchema } from '../../../src/config/schema.ts';
import { buildPortalHttp, runPortalSync } from '../../../src/crawler/portal-sync.ts';
import { runMigrations } from '../../../src/store/migrate.ts';

const MIGRATIONS = fileURLToPath(new URL('../../../migrations', import.meta.url));

function tmpStore(): string {
  const root = join(globalThis.__TEST_TMP_DIR__, `ps-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  return root;
}

function migratedDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db, MIGRATIONS);
  return db;
}

function makeConfig(api: 'ckan' | 'egov-bg', storeRoot: string): DanniConfig {
  // obey:false short-circuits the robots check (no robots.txt fetch), keeping the test offline.
  return DanniConfigSchema.parse({
    portal: { baseUrl: 'https://data.egov.bg/api/', api },
    crawler: {
      userAgent: 'danni-bg/test',
      rateLimit: { requestsPerSecondPerHost: 10 },
      concurrency: { maxConcurrentRequestsPerHost: 4 },
      backoff: { initialMs: 100, maxMs: 1000, failureBudget: 1 },
      robots: { recheckIntervalSeconds: 86400, obey: false },
    },
    store: { root: storeRoot },
    schedule: {
      enabled: false,
      cron: null,
      onOverlap: 'skip',
      failureRateThreshold: 1,
      notifier: { kind: 'stderr' },
    },
    scope: {},
    enrichment: {
      translator: { provider: 'local-marianmt' },
      embedder: { provider: 'local-onnx' },
    },
    index: { incremental: false },
  });
}

/** Records every requested URL and serves empty-but-valid discovery for both portal APIs. */
function recordingFetcher(urls: string[]): typeof fetch {
  return (async (url: string | URL) => {
    const u = url.toString();
    urls.push(u);
    if (u.includes('listDatasets')) {
      return new Response(JSON.stringify({ success: true, datasets: [] }), { status: 200 });
    }
    if (u.includes('package_search')) {
      return new Response(JSON.stringify({ success: true, result: { count: 0, results: [] } }), {
        status: 200,
      });
    }
    return new Response(JSON.stringify({ success: true, result: {} }), { status: 200 });
  }) as unknown as typeof fetch;
}

// Regression guard for the scheduler bug: schedule.ts used to hardcode CkanClient, so a scheduled
// crawl of the live data.egov.bg portal (api: 'egov-bg') silently issued CKAN calls that all fail.
// Both the interactive and scheduled entry points now dispatch through runPortalSync.
describe('crawler.portal-sync dispatch (FR-007)', () => {
  it("routes portal.api='egov-bg' to the egov adapter (listDatasets), never CKAN", async () => {
    const db = migratedDb();
    const storeRoot = tmpStore();
    const config = makeConfig('egov-bg', storeRoot);
    const urls: string[] = [];
    const http = buildPortalHttp(config, recordingFetcher(urls));
    try {
      const res = await runPortalSync({
        db,
        config,
        http,
        storeRoot,
        trigger: 'manual',
        scope: {},
      });
      expect(res.api).toBe('egov-bg');
      expect(urls.some((u) => u.includes('listDatasets'))).toBe(true);
      expect(urls.some((u) => u.includes('package_search'))).toBe(false);
    } finally {
      db.close();
    }
  });

  it("routes portal.api='ckan' to the CKAN adapter (package_search), never egov", async () => {
    const db = migratedDb();
    const storeRoot = tmpStore();
    const config = makeConfig('ckan', storeRoot);
    const urls: string[] = [];
    const http = buildPortalHttp(config, recordingFetcher(urls));
    try {
      const res = await runPortalSync({ db, config, http, storeRoot, trigger: 'manual' });
      expect(res.api).toBe('ckan');
      expect(urls.some((u) => u.includes('package_search'))).toBe(true);
      expect(urls.some((u) => u.includes('listDatasets'))).toBe(false);
    } finally {
      db.close();
    }
  });
});
