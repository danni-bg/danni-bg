import type { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DanniConfig } from '../../src/config/schema.ts';
import type { EgovBgClient } from '../../src/crawler/egov-bg-client.ts';
import { runEgovSyncRun } from '../../src/crawler/run-egov-sync.ts';
import { UnsupportedScopeFieldError } from '../../src/crawler/scope.ts';
import { LockContentionError } from '../../src/manifest/sync-run.ts';
import type { NotificationPayload, Notifier } from '../../src/notify/notifier.ts';
import { openDb } from '../../src/store/db.ts';
import { runMigrations } from '../../src/store/migrate.ts';
import { CrawlCheckpointsRepo } from '../../src/store/repos/crawl-checkpoints.ts';
import { DatasetsRepo } from '../../src/store/repos/datasets.ts';
import { SyncRunEventsRepo } from '../../src/store/repos/sync-run-events.ts';
import { SyncRunsLockRepo } from '../../src/store/repos/sync-runs-lock.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIX = fileURLToPath(new URL('../fixtures/egov/', import.meta.url));
const fix = (n: string) => JSON.parse(readFileSync(join(FIX, `${n}.json`), 'utf-8'));
const DATASET_URI = fix('getDatasetDetails').data.uri as string;

function fakeClient(overrides: Partial<Record<string, () => unknown>> = {}): EgovBgClient {
  return {
    listDatasets: async () => overrides.listDatasets?.() ?? { success: true, datasets: [] },
    getDatasetDetails: async () => overrides.getDatasetDetails?.() ?? fix('getDatasetDetails'),
    listResources: async () => overrides.listResources?.() ?? fix('listResources'),
    getResourceData: async () => overrides.getResourceData?.() ?? fix('getResourceData'),
    listOrganisations: async () => fix('listOrganisations'),
  } as unknown as EgovBgClient;
}

function testConfig(): DanniConfig {
  return {
    schedule: {
      onOverlap: 'skip',
      failureRateThreshold: 0.5,
      enabled: false,
      timezone: 'Europe/Sofia',
      notifier: { kind: 'stderr' },
    },
  } as unknown as DanniConfig;
}

function freshDb(storeRoot: string): Database {
  const db = openDb({ storeRoot, loadVec: false });
  runMigrations(db, join(ROOT, 'migrations'));
  return db;
}

describe('crawler.run-egov-sync', () => {
  it('acquires the lock, records events, finalizes via handle.end, writes a manifest', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const db = freshDb(storeRoot);
    const result = await runEgovSyncRun({
      db,
      config: testConfig(),
      client: fakeClient(),
      storeRoot,
      trigger: 'manual',
      scope: { datasetIds: [DATASET_URI] },
    });
    expect(result.summaryOutcome).toBe('success');
    expect(result.totals.captured).toBe(3);
    expect(result.manifestPath).not.toBeNull();
    expect(existsSync(result.manifestPath as string)).toBe(true);
    expect(new SyncRunsLockRepo(db).state().is_locked).toBe(0);
    const events = new SyncRunEventsRepo(db).listByRun(result.runId);
    expect(events.some((e) => e.outcome === 'discovered')).toBe(true);
    expect(events.filter((e) => e.outcome === 'captured').length).toBe(3);
    db.close();
  });

  it('records the checkpoint success rows after capture (consistent with bytes on disk)', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const db = freshDb(storeRoot);
    const result = await runEgovSyncRun({
      db,
      config: testConfig(),
      client: fakeClient(),
      storeRoot,
      trigger: 'manual',
      scope: { datasetIds: [DATASET_URI] },
    });
    const repo = new CrawlCheckpointsRepo(db);
    const rows = repo.listResources(result.scopeHash, DATASET_URI);
    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(r.outcome).toBe('success');
      expect(r.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    db.close();
  });

  it('dispatches the notifier on a failed run', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const db = freshDb(storeRoot);
    const dispatched: NotificationPayload[] = [];
    const notifier: Notifier = {
      channel: 'test',
      dispatch: async (p) => {
        dispatched.push(p);
      },
    };
    const result = await runEgovSyncRun({
      db,
      config: testConfig(),
      client: fakeClient({
        getResourceData: () => {
          throw new Error('capture boom');
        },
      }),
      storeRoot,
      trigger: 'manual',
      scope: { datasetIds: [DATASET_URI] },
      notifier,
    });
    expect(result.summaryOutcome).toBe('failed');
    expect(dispatched.some((d) => d.kind === 'run_failed')).toBe(true);
    db.close();
  });

  it('dispatches a threshold notification when failure rate exceeds the configured threshold', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const db = freshDb(storeRoot);
    const dispatched: NotificationPayload[] = [];
    const notifier: Notifier = {
      channel: 'test',
      dispatch: async (p) => {
        dispatched.push(p);
      },
    };
    const config = testConfig();
    config.schedule.failureRateThreshold = 0.1;
    // One resource fails, two succeed → rate 1/3 > 0.1, but the run is "partial" not "failed".
    let call = 0;
    const result = await runEgovSyncRun({
      db,
      config,
      client: fakeClient({
        getResourceData: () => {
          call++;
          if (call === 1) throw new Error('one bad');
          return fix('getResourceData');
        },
      }),
      storeRoot,
      trigger: 'manual',
      scope: { datasetIds: [DATASET_URI] },
      notifier,
    });
    expect(result.summaryOutcome).toBe('partial');
    expect(dispatched.some((d) => d.kind === 'threshold_exceeded')).toBe(true);
    db.close();
  });

  it('re-throws LockContentionError when the lock is already held', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const db = freshDb(storeRoot);
    new SyncRunsLockRepo(db).tryAcquire('held-by-other');
    await expect(
      runEgovSyncRun({
        db,
        config: testConfig(),
        client: fakeClient(),
        storeRoot,
        trigger: 'manual',
        scope: { datasetIds: [DATASET_URI] },
      }),
    ).rejects.toBeInstanceOf(LockContentionError);
    db.close();
  });

  it('aborts before any capture on an unsupported categories scope (spec 048 SC-2)', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const db = freshDb(storeRoot);
    await expect(
      runEgovSyncRun({
        db,
        config: testConfig(),
        client: fakeClient(),
        storeRoot,
        trigger: 'manual',
        scope: { categories: ['транспорт'] },
      }),
    ).rejects.toBeInstanceOf(UnsupportedScopeFieldError);
    // No lock acquired, no dataset captured — aborted before touching the portal.
    expect(new SyncRunsLockRepo(db).state().is_locked).toBe(0);
    expect(new DatasetsRepo(db).get(DATASET_URI)).toBeNull();
    db.close();
  });

  it('a datasetIds scope still captures exactly the requested dataset (unchanged behavior)', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const db = freshDb(storeRoot);
    const result = await runEgovSyncRun({
      db,
      config: testConfig(),
      client: fakeClient(),
      storeRoot,
      trigger: 'manual',
      scope: { datasetIds: [DATASET_URI] },
    });
    expect(result.totals.captured).toBe(3);
    expect(result.totals.outOfScope).toBe(0);
    expect(new CrawlCheckpointsRepo(db).frozenIds(result.scopeHash)).toEqual([DATASET_URI]);
    db.close();
  });

  it('aborts (finalizes failed, releases lock) when discovery throws', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const db = freshDb(storeRoot);
    await expect(
      runEgovSyncRun({
        db,
        config: testConfig(),
        client: fakeClient({
          listDatasets: () => {
            throw new Error('discovery down');
          },
        }),
        storeRoot,
        trigger: 'manual',
        scope: {},
      }),
    ).rejects.toThrow('discovery down');
    // lock released by abort
    expect(new SyncRunsLockRepo(db).state().is_locked).toBe(0);
    db.close();
  });
});
