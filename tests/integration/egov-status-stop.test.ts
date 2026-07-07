import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run as cliStatus } from '../../src/cli/status.ts';
import type { DanniConfig } from '../../src/config/schema.ts';
import { runEgovSyncRun } from '../../src/crawler/run-egov-sync.ts';
import { computeScopeHash } from '../../src/crawler/scope-hash.ts';
import { openDb } from '../../src/store/db.ts';
import { runMigrations } from '../../src/store/migrate.ts';
import { CrawlCheckpointsRepo } from '../../src/store/repos/crawl-checkpoints.ts';
import { makeCatalog } from './egov-fixtures.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function testConfig(): DanniConfig {
  return {
    schedule: {
      onOverlap: 'skip',
      failureRateThreshold: 1,
      enabled: false,
      notifier: { kind: 'stderr' },
    },
    scope: {},
  } as unknown as DanniConfig;
}

function writeConfig(storeRoot: string): void {
  writeFileSync(
    join(storeRoot, 'danni.config.json'),
    JSON.stringify({
      portal: { baseUrl: 'https://data.egov.bg/api/', api: 'egov-bg' },
      crawler: {
        userAgent: 'danni-test/1.0',
        rateLimit: { requestsPerSecondPerHost: 1 },
        concurrency: { maxConcurrentRequestsPerHost: 1 },
        backoff: { initialMs: 100, maxMs: 1000, failureBudget: 5 },
        robots: { recheckIntervalSeconds: 60, obey: false, allowHosts: [] },
      },
      store: { root: '.' },
      schedule: {
        enabled: false,
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
    }),
  );
}

describe('integration.egov-status-stop (US3: progress + safe stop)', () => {
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

  it('danni status --json reports discovered/captured/failed/remaining for the campaign', async () => {
    const config = testConfig();
    const catalog = makeCatalog(5, 2);
    // Partial crawl: 2 of 5 datasets.
    await runEgovSyncRun({
      db,
      config,
      client: catalog.client(),
      storeRoot,
      trigger: 'manual',
      scope: {},
      max: 2,
    });
    db.close();

    writeConfig(storeRoot);
    const cwd = process.cwd();
    let captured = '';
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      captured += chunk;
      return true;
    }) as typeof process.stdout.write;
    process.chdir(storeRoot);
    try {
      const code = await cliStatus(['--json']);
      expect(code).toBe(0);
    } finally {
      process.stdout.write = origWrite;
      process.chdir(cwd);
    }
    const parsed = JSON.parse(captured);
    expect(parsed.crawlCampaigns).toHaveLength(1);
    const c = parsed.crawlCampaigns[0];
    expect(c.total).toBe(5);
    expect(c.discovered).toBe(2);
    expect(c.captured).toBe(2);
    expect(c.failed).toBe(0);
    expect(c.remaining).toBe(3);
    // re-open for afterEach cleanup
    db = openDb({ storeRoot, loadVec: false });
  });

  it('human status output includes a crawlCampaigns line', async () => {
    const config = testConfig();
    const catalog = makeCatalog(3, 1);
    await runEgovSyncRun({
      db,
      config,
      client: catalog.client(),
      storeRoot,
      trigger: 'manual',
      scope: {},
      max: 1,
    });
    db.close();

    writeConfig(storeRoot);
    const cwd = process.cwd();
    let out = '';
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      out += chunk;
      return true;
    }) as typeof process.stdout.write;
    process.chdir(storeRoot);
    try {
      await cliStatus([]);
    } finally {
      process.stdout.write = origWrite;
      process.chdir(cwd);
    }
    expect(out).toContain('crawlCampaigns:');
    expect(out).toMatch(/total=3 discovered=1 captured=1/);
    db = openDb({ storeRoot, loadVec: false });
  });

  it('stopping at a dataset boundary persists the cursor; a resume continues with no lost/dup work', async () => {
    const config = testConfig();
    const catalog = makeCatalog(4, 2);
    const { scopeHash } = computeScopeHash({});
    const repo = new CrawlCheckpointsRepo(db);

    // Stop after 2 datasets.
    await runEgovSyncRun({
      db,
      config,
      client: catalog.client(),
      storeRoot,
      trigger: 'manual',
      scope: {},
      max: 2,
    });
    expect(repo.getCampaign(scopeHash)?.cursor_uri).toBe('ds-001');
    const capturedAfterStop = repo.counts(scopeHash).captured;
    expect(capturedAfterStop).toBe(2);

    // Resume continues from ds-002 with no lost/dup work.
    const r = await runEgovSyncRun({
      db,
      config,
      client: catalog.client(),
      storeRoot,
      trigger: 'manual',
      scope: {},
    });
    expect(r.completed).toBe(true);
    expect(repo.counts(scopeHash).captured).toBe(4);
    // ds-000/ds-001 captured exactly once (not re-fetched on resume).
    expect(catalog.resourceDataCalls('ds-000-r0')).toBe(1);
    expect(catalog.resourceDataCalls('ds-003-r0')).toBe(1);
  });
});
