import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run as cliSync } from '../../src/cli/sync.ts';
import type { DanniConfig } from '../../src/config/schema.ts';
import { runEgovSyncRun } from '../../src/crawler/run-egov-sync.ts';
import { computeScopeHash } from '../../src/crawler/scope-hash.ts';
import { LockContentionError, beginSyncRun } from '../../src/manifest/sync-run.ts';
import { openDb } from '../../src/store/db.ts';
import { runMigrations } from '../../src/store/migrate.ts';
import { CrawlCheckpointsRepo } from '../../src/store/repos/crawl-checkpoints.ts';
import { DatasetsRepo } from '../../src/store/repos/datasets.ts';
import { SyncRunsLockRepo } from '../../src/store/repos/sync-runs-lock.ts';
import { SyncRunsRepo } from '../../src/store/repos/sync-runs.ts';
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

describe('integration.egov-edge-cases', () => {
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

  describe('atomic capture (US1, FR-005/SC-003)', () => {
    it('a write that fails before rename leaves no success row and no partial file', async () => {
      const catalog = makeCatalog(1, 1);
      // Force the per-resource directory creation to fail by planting a FILE where the dataset's
      // raw directory must be created — ensureDir(dirname) then throws ENOTDIR before any rename.
      mkdirSync(join(storeRoot, 'raw'), { recursive: true });
      writeFileSync(join(storeRoot, 'raw', 'ds-000'), 'blocker');

      await expect(
        runEgovSyncRun({
          db,
          config: testConfig(),
          client: catalog.client(),
          storeRoot,
          trigger: 'manual',
          scope: {},
        }),
      ).rejects.toThrow();

      const { scopeHash } = computeScopeHash({});
      const repo = new CrawlCheckpointsRepo(db);
      const rows = repo.listResources(scopeHash, 'ds-000');
      // No success row recorded (the write threw before markResourceSuccess).
      expect(rows.every((r) => r.outcome !== 'success')).toBe(true);
      // No file at the final raw path (the blocker is a file, not the captured bytes).
      expect(existsSync(join(storeRoot, 'raw', 'ds-000', 'ds-000-r0', 'raw.json'))).toBe(false);
      // The lock was released by abort so the next session is not wedged.
      expect(new SyncRunsLockRepo(db).state().is_locked).toBe(0);
    });
  });

  describe('mutual exclusion (US1, FR-007 / 001 FR-017c)', () => {
    it('a second egov run and a CKAN run are rejected while the lock is held', async () => {
      // Hold the single lock as a concurrent live run would (lock row held; no stale sync_runs row
      // to reap — mirrors tests/integration/concurrent-runs.test.ts).
      const lock = new SyncRunsLockRepo(db);
      lock.tryAcquire('held-by-other');
      const catalog = makeCatalog(1, 1);
      // A second egov run is rejected with LockContentionError.
      await expect(
        runEgovSyncRun({
          db,
          config: testConfig(),
          client: catalog.client(),
          storeRoot,
          trigger: 'manual',
          scope: {},
        }),
      ).rejects.toBeInstanceOf(LockContentionError);
      // A CKAN run shares the SAME lock → also rejected.
      expect(() =>
        beginSyncRun({ db, storeRoot, trigger: 'manual', scopeFilter: {}, onOverlap: 'skip' }),
      ).toThrow(LockContentionError);
      // After the holder releases, a subsequent egov run acquires the lock and succeeds.
      lock.release('held-by-other');
      const r = await runEgovSyncRun({
        db,
        config: testConfig(),
        client: catalog.client(),
        storeRoot,
        trigger: 'manual',
        scope: {},
      });
      expect(r.summaryOutcome).toBe('success');
    });

    it('an abandoned egov run is reaped so the lock never wedges the next session', () => {
      // Acquire the lock and create a stale running sync_runs row, then leave it (process exit).
      const handle = beginSyncRun({
        db,
        storeRoot,
        trigger: 'manual',
        scopeFilter: {},
        onOverlap: 'skip',
      });
      expect(new SyncRunsLockRepo(db).state().is_locked).toBe(1);
      void handle;
      // The NEXT beginSyncRun reaps the abandoned run and force-releases the lock.
      const next = beginSyncRun({
        db,
        storeRoot,
        trigger: 'manual',
        scopeFilter: {},
        onOverlap: 'skip',
      });
      expect(next.runId).toBeDefined();
      const runs = new SyncRunsRepo(db).recent(10);
      expect(runs.some((r) => r.summary_outcome === 'failed')).toBe(true);
      next.abort('cleanup');
    });
  });

  describe('validator-change re-fetch (US1, FR-002/SC-001)', () => {
    it('only the bumped dataset is re-fetched; unchanged datasets issue zero getResourceData', async () => {
      const catalog = makeCatalog(3, 2);
      const config = testConfig();
      // Session 1: full crawl.
      await runEgovSyncRun({
        db,
        config,
        client: catalog.client(),
        storeRoot,
        trigger: 'manual',
        scope: {},
      });
      const callsAfter1 = { ...catalog.calls.getResourceData };

      // Bump exactly ONE dataset's validator (id-set unchanged).
      catalog.bump('ds-001', '2026-07-01 00:00:00', '2.0');

      // Session 2: resume (campaign already completed → re-open by reconcile is not needed; the
      // planner still resumes because a completed campaign with a fresh session re-scans uris).
      // Force a fresh session by clearing completion via a new run on the same scope.
      await runEgovSyncRun({
        db,
        config,
        client: catalog.client(),
        storeRoot,
        trigger: 'manual',
        scope: {},
      });

      // The bumped dataset's details were re-fetched and its validator re-written.
      const ds = new DatasetsRepo(db).get('ds-001');
      expect(ds?.source_etag_or_hash).toBe('ts:2026-07-01 00:00:00|v:2.0');
      // Its resources were re-fetched (one more call than after session 1).
      expect(catalog.resourceDataCalls('ds-001-r0')).toBe((callsAfter1['ds-001-r0'] ?? 0) + 1);
      // Every UNCHANGED dataset issued ZERO new getResourceData on resume.
      for (const uri of ['ds-000-r0', 'ds-000-r1', 'ds-002-r0', 'ds-002-r1']) {
        expect(catalog.resourceDataCalls(uri)).toBe(callsAfter1[uri] ?? 0);
      }
    });
  });

  describe('capped failure + --retry-failed (US3, FR-009)', () => {
    it('a persistent failure is recorded, the cursor advances, and retry is capped', async () => {
      // Build a catalog whose ds-000 resource persistently fails.
      const catalog = makeCatalog(2, 1);
      const baseClient = catalog.client();
      const client = {
        ...baseClient,
        getResourceData: async (uri: string) => {
          if (uri === 'ds-000-r0') throw new Error('always down');
          return baseClient.getResourceData(uri);
        },
      } as typeof baseClient;

      const config = testConfig();
      const { scopeHash } = computeScopeHash({});
      const repo = new CrawlCheckpointsRepo(db);

      // Run 1: ds-000 fails, ds-001 succeeds, cursor advances past ds-000.
      await runEgovSyncRun({ db, config, client, storeRoot, trigger: 'manual', scope: {} });
      expect(repo.getDataset(scopeHash, 'ds-000')?.outcome).toBe('failed');
      expect(repo.getDataset(scopeHash, 'ds-000')?.attempts).toBe(1);
      expect(repo.getDataset(scopeHash, 'ds-001')?.outcome).toBe('complete');
      expect(repo.getCampaign(scopeHash)?.cursor_uri).toBe('ds-001');

      // A normal resume SKIPS the failure (no new attempt).
      await runEgovSyncRun({ db, config, client, storeRoot, trigger: 'manual', scope: {} });
      expect(repo.getDataset(scopeHash, 'ds-000')?.attempts).toBe(1);

      // --retry-failed re-attempts it (attempt 2), still failing.
      await runEgovSyncRun({
        db,
        config,
        client,
        storeRoot,
        trigger: 'manual',
        scope: {},
        retryFailed: true,
      });
      expect(repo.getDataset(scopeHash, 'ds-000')?.attempts).toBe(2);
      // remaining still counts ds-000 (sub-cap).
      expect(repo.remaining(scopeHash)).toBe(1);

      // Retry again → attempt 3 == cap. Now excluded from remaining.
      await runEgovSyncRun({
        db,
        config,
        client,
        storeRoot,
        trigger: 'manual',
        scope: {},
        retryFailed: true,
      });
      expect(repo.getDataset(scopeHash, 'ds-000')?.attempts).toBe(3);
      expect(repo.remaining(scopeHash)).toBe(0);

      // A further --retry-failed does NOT exceed the cap (no attempt 4).
      await runEgovSyncRun({
        db,
        config,
        client,
        storeRoot,
        trigger: 'manual',
        scope: {},
        retryFailed: true,
      });
      expect(repo.getDataset(scopeHash, 'ds-000')?.attempts).toBe(3);
    });

    it('on --retry-failed re-walk, an already-success resource is skipped while the failed one retries', async () => {
      // ds-000 has two resources: r0 succeeds, r1 fails persistently → dataset is `failed`.
      const catalog = makeCatalog(1, 2);
      const baseClient = catalog.client();
      const client = {
        ...baseClient,
        getResourceData: async (uri: string) => {
          if (uri === 'ds-000-r1') throw new Error('r1 down');
          return baseClient.getResourceData(uri);
        },
      } as typeof baseClient;
      const config = testConfig();
      const { scopeHash } = computeScopeHash({});
      const repo = new CrawlCheckpointsRepo(db);

      await runEgovSyncRun({ db, config, client, storeRoot, trigger: 'manual', scope: {} });
      expect(repo.getResource(scopeHash, 'ds-000', 'ds-000-r0')?.outcome).toBe('success');
      expect(repo.getResource(scopeHash, 'ds-000', 'ds-000-r1')?.outcome).toBe('failed');
      const r0CallsBefore = catalog.resourceDataCalls('ds-000-r0');

      // --retry-failed re-opens the dataset and re-walks it: r0 (already success, same validator)
      // is SKIPPED (skipped_unchanged), only r1 is re-fetched.
      const r = await runEgovSyncRun({
        db,
        config,
        client,
        storeRoot,
        trigger: 'manual',
        scope: {},
        retryFailed: true,
      });
      expect(r.totals.skippedUnchanged).toBeGreaterThanOrEqual(1);
      // r0 was NOT re-fetched on the retry; r1 was.
      expect(catalog.resourceDataCalls('ds-000-r0')).toBe(r0CallsBefore);
      expect(repo.getResource(scopeHash, 'ds-000', 'ds-000-r1')?.attempts).toBe(2);
    });
  });

  describe('lost-checkpoint degradation (US3, FR-008/SC-003)', () => {
    it('a deleted checkpoint is rebuilt and on-disk content is reused (no re-download)', async () => {
      const catalog = makeCatalog(3, 2);
      const config = testConfig();
      await runEgovSyncRun({
        db,
        config,
        client: catalog.client(),
        storeRoot,
        trigger: 'manual',
        scope: {},
      });
      const callsAfter1 = { ...catalog.calls.getResourceData };
      // Record the on-disk mtime of an already-captured file.
      const rawFile = join(storeRoot, 'raw', 'ds-000', 'ds-000-r0', 'raw.json');
      const mtimeBefore = statSync(rawFile).mtimeMs;

      // Lose the checkpoint (cascades children).
      db.query('DELETE FROM crawl_checkpoints').run();
      const { scopeHash } = computeScopeHash({});
      expect(new CrawlCheckpointsRepo(db).getCampaign(scopeHash)).toBeNull();

      // Re-invoke: re-scan rebuilds the checkpoint. Bytes are unchanged, but because the
      // checkpoint is gone the planner cannot skip at the dataset level — so resources ARE
      // re-fetched here (datastore has no per-resource validator). The corpus stays consistent.
      const r = await runEgovSyncRun({
        db,
        config,
        client: catalog.client(),
        storeRoot,
        trigger: 'manual',
        scope: {},
      });
      expect(r.summaryOutcome).toBe('success');
      expect(new CrawlCheckpointsRepo(db).getCampaign(scopeHash)).not.toBeNull();
      // Re-fetch happened (degradation re-scans), but the final corpus is consistent.
      const repo = new CrawlCheckpointsRepo(db);
      expect(repo.counts(scopeHash).captured).toBe(3);
      for (const uri of Object.keys(callsAfter1)) {
        expect(catalog.resourceDataCalls(uri)).toBeGreaterThanOrEqual(callsAfter1[uri] as number);
      }
      // FR-008 on-disk reuse: the unchanged file was NOT re-written (identical bytes → mtime kept).
      expect(statSync(rawFile).mtimeMs).toBe(mtimeBefore);
    });

    it('a corrupt frozen_ids_json degrades to a safe re-scan (CheckpointCorruptError branch)', async () => {
      const catalog = makeCatalog(2, 1);
      const config = testConfig();
      await runEgovSyncRun({
        db,
        config,
        client: catalog.client(),
        storeRoot,
        trigger: 'manual',
        scope: {},
      });
      const { scopeHash } = computeScopeHash({});
      // Corrupt the persisted frozen ids.
      db.query('UPDATE crawl_checkpoints SET frozen_ids_json = ? WHERE scope_hash = ?').run(
        '{bad json',
        scopeHash,
      );
      const r = await runEgovSyncRun({
        db,
        config,
        client: catalog.client(),
        storeRoot,
        trigger: 'manual',
        scope: {},
      });
      expect(r.summaryOutcome).toBe('success');
      // The row was rebuilt with a valid frozen list.
      expect(new CrawlCheckpointsRepo(db).frozenIds(scopeHash)).toEqual(['ds-000', 'ds-001']);
    });
  });

  describe('id-set add/remove (US3, FR-004)', () => {
    it('a newly added dataset is eventually visited and a vanished one is handled (reconcile)', async () => {
      const catalog = makeCatalog(3, 1);
      const config = testConfig();
      // Session 1: full crawl of ds-000..ds-002.
      await runEgovSyncRun({
        db,
        config,
        client: catalog.client(),
        storeRoot,
        trigger: 'manual',
        scope: {},
      });
      const { scopeHash } = computeScopeHash({});
      const repo = new CrawlCheckpointsRepo(db);
      expect(repo.getCampaign(scopeHash)?.status).toBe('completed');

      // Between sessions: add a new dataset, remove an existing one.
      catalog.add({
        uri: 'ds-999',
        name: 'Нов набор',
        orgId: 1,
        updatedAt: '2026-08-01 00:00:00',
        version: '1.0',
        resources: [{ uri: 'ds-999-r0', data: [['A'], ['1']] }],
      });
      catalog.hide('ds-001');

      // Reconcile pass (T222/T232) appends ds-999 and processes it; resume of a completed campaign
      // triggers reconciliation.
      const r = await runEgovSyncRun({
        db,
        config,
        client: catalog.client(),
        storeRoot,
        trigger: 'manual',
        scope: {},
      });
      expect(r.summaryOutcome).toBe('success');
      // ds-999 was appended to the frozen list and captured.
      expect(repo.frozenIds(scopeHash)).toContain('ds-999');
      expect(catalog.resourceDataCalls('ds-999-r0')).toBe(1);
      // The vanished ds-001 is handled per withdrawal (its dataset row is marked withdrawn).
      expect(new DatasetsRepo(db).get('ds-001')?.lifecycle_state).toBe('withdrawn');
    });
  });

  describe('CLI lock contention → exit 5', () => {
    it('runs the egov CLI branch; LockContentionError maps to exit 5', async () => {
      // Hold the lock, then drive the CLI egov branch via a config file so loadConfig resolves it.
      // The CLI builds its own db via openDb(store.root); we point store.root at this temp store.
      const cwd = process.cwd();
      process.chdir(storeRoot);
      try {
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
            scope: { datasetIds: ['x'] },
            enrichment: {
              translator: { provider: 'local-marianmt' },
              embedder: { provider: 'local-onnx' },
            },
            index: { incremental: false },
          }),
        );
        // Hold the lock on the CLI's db file.
        new SyncRunsLockRepo(db).tryAcquire('held');
        const code = await cliSync(['--max', '5']);
        expect(code).toBe(5);
      } finally {
        process.chdir(cwd);
      }
    });
  });
});
