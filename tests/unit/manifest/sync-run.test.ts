import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DanniConfig } from '../../../src/config/schema.ts';
import {
  LockContentionError,
  beginSyncRun,
  failureRate,
  finalizeSyncRun,
  guardSyncRun,
  reapAbandonedRuns,
} from '../../../src/manifest/sync-run.ts';
import type { ManifestTotals } from '../../../src/manifest/writer.ts';
import type { NotificationPayload, Notifier } from '../../../src/notify/notifier.ts';
import { runMigrations } from '../../../src/store/migrate.ts';
import { SyncRunsLockRepo } from '../../../src/store/repos/sync-runs-lock.ts';
import { SyncRunsRepo } from '../../../src/store/repos/sync-runs.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const MIGRATIONS = join(ROOT, 'migrations');

function db(): Database {
  const d = new Database(':memory:');
  d.exec('PRAGMA foreign_keys = ON;');
  runMigrations(d, MIGRATIONS);
  return d;
}

const ZERO_TOTALS = {
  discovered: 0,
  captured: 0,
  skippedUnchanged: 0,
  failed: 0,
  withdrawn: 0,
  outOfScope: 0,
};

describe('manifest.sync-run lifecycle', () => {
  let database: Database;
  let storeRoot: string;
  beforeEach(() => {
    database = db();
    storeRoot = globalThis.__TEST_TMP_DIR__;
  });
  afterEach(() => {
    database.close();
  });

  it('begin acquires the lock and end writes a manifest + finalizes the row', () => {
    const handle = beginSyncRun({
      db: database,
      storeRoot,
      trigger: 'manual',
      scopeFilter: {},
      onOverlap: 'skip',
    });
    handle.recordEvent({ datasetId: 'd1', outcome: 'discovered' });
    const result = handle.end({
      summaryOutcome: 'success',
      totals: { ...ZERO_TOTALS, discovered: 1 },
      datasetEntries: [],
    });
    expect(existsSync(result.manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf-8'));
    expect(manifest.summaryOutcome).toBe('success');
    const row = new SyncRunsRepo(database).get(handle.runId);
    expect(row?.summary_outcome).toBe('success');
    expect(new SyncRunsLockRepo(database).state().is_locked).toBe(0);
  });

  it('append-once invariant: end twice throws', () => {
    const handle = beginSyncRun({
      db: database,
      storeRoot,
      trigger: 'manual',
      scopeFilter: {},
      onOverlap: 'skip',
    });
    handle.end({ summaryOutcome: 'success', totals: ZERO_TOTALS, datasetEntries: [] });
    expect(() =>
      handle.end({ summaryOutcome: 'success', totals: ZERO_TOTALS, datasetEntries: [] }),
    ).toThrow();
  });

  it('contention with onOverlap=skip throws LockContentionError', () => {
    // Hold the lock without a corresponding sync_runs row so the reaper can't release it.
    new SyncRunsLockRepo(database).tryAcquire('external-holder');
    expect(() =>
      beginSyncRun({
        db: database,
        storeRoot,
        trigger: 'manual',
        scopeFilter: {},
        onOverlap: 'skip',
      }),
    ).toThrow(LockContentionError);
  });

  it('contention with onOverlap=queue still surfaces LockContentionError to the caller', () => {
    new SyncRunsLockRepo(database).tryAcquire('external-holder');
    expect(() =>
      beginSyncRun({
        db: database,
        storeRoot,
        trigger: 'manual',
        scopeFilter: {},
        onOverlap: 'queue',
      }),
    ).toThrow(LockContentionError);
  });

  it('abort marks the run failed and releases the lock', () => {
    const handle = beginSyncRun({
      db: database,
      storeRoot,
      trigger: 'manual',
      scopeFilter: {},
      onOverlap: 'skip',
    });
    handle.abort('boom');
    expect(new SyncRunsLockRepo(database).state().is_locked).toBe(0);
    const row = new SyncRunsRepo(database).get(handle.runId);
    expect(row?.summary_outcome).toBe('failed');
    expect(row?.notes).toContain('aborted: boom');
  });

  it('abort after end is a no-op', () => {
    const handle = beginSyncRun({
      db: database,
      storeRoot,
      trigger: 'manual',
      scopeFilter: {},
      onOverlap: 'skip',
    });
    handle.end({ summaryOutcome: 'success', totals: ZERO_TOTALS, datasetEntries: [] });
    handle.abort('too-late'); // should not throw
    const row = new SyncRunsRepo(database).get(handle.runId);
    expect(row?.summary_outcome).toBe('success');
  });

  it('reapAbandonedRuns marks stale runs failed and force-releases lock', () => {
    new SyncRunsRepo(database).create({
      id: 'stale',
      trigger: 'manual',
      scopeFilterJson: '{}',
    });
    new SyncRunsLockRepo(database).tryAcquire('stale');
    const ids = reapAbandonedRuns(database);
    expect(ids).toContain('stale');
    expect(new SyncRunsLockRepo(database).state().is_locked).toBe(0);
    const row = new SyncRunsRepo(database).get('stale');
    expect(row?.summary_outcome).toBe('failed');
  });

  it('reapAbandonedRuns is a no-op when no runs are stale', () => {
    const ids = reapAbandonedRuns(database);
    expect(ids).toEqual([]);
  });

  it('failureRate handles zero discovered', () => {
    expect(failureRate({ ...ZERO_TOTALS })).toBe(0);
    expect(failureRate({ ...ZERO_TOTALS, discovered: 4, failed: 1 })).toBeCloseTo(0.25);
  });

  it('LockContentionError exposes heldByRunId', () => {
    const err = new LockContentionError('held-by');
    expect(err.heldByRunId).toBe('held-by');
    expect(err.name).toBe('LockContentionError');
  });

  it('LockContentionError handles null held_by', () => {
    const err = new LockContentionError(null);
    expect(err.message).toContain('unknown run');
  });

  // The shared sync-runner epilogue (spec 055 FR-371/372). The end-to-end egov path is covered by
  // tests/unit/run-egov-sync.test.ts; these exercise the extracted helpers directly (judge-independent).
  const configWith = (failureRateThreshold: number): DanniConfig =>
    ({ schedule: { failureRateThreshold } }) as unknown as DanniConfig;

  const collectNotifier = (sink: NotificationPayload[]): Notifier => ({
    channel: 'test',
    dispatch: async (p) => {
      sink.push(p);
    },
  });

  const begin = () =>
    beginSyncRun({
      db: database,
      storeRoot,
      trigger: 'manual',
      scopeFilter: {},
      onOverlap: 'skip',
    });

  it('finalizeSyncRun derives success/partial/failed from totals', async () => {
    const cases: Array<[Partial<ManifestTotals>, 'success' | 'partial' | 'failed']> = [
      [{ discovered: 2, captured: 2 }, 'success'],
      [{ discovered: 3, captured: 2, failed: 1 }, 'partial'],
      [{ discovered: 3, skippedUnchanged: 2, failed: 1 }, 'partial'],
      [{ discovered: 2, captured: 0, failed: 2 }, 'failed'],
    ];
    for (const [partial, expected] of cases) {
      const handle = begin();
      const totals = { ...ZERO_TOTALS, ...partial };
      const { summaryOutcome, manifestPath } = await finalizeSyncRun(handle, totals, [], {
        db: database,
        config: configWith(0.5),
        failedSummary: 'sync run failed',
      });
      expect(summaryOutcome).toBe(expected);
      expect(existsSync(manifestPath)).toBe(true);
      expect(new SyncRunsLockRepo(database).state().is_locked).toBe(0);
    }
  });

  it('finalizeSyncRun dispatches run_failed with the parameterized summary', async () => {
    const dispatched: NotificationPayload[] = [];
    const handle = begin();
    await finalizeSyncRun(handle, { ...ZERO_TOTALS, discovered: 2, failed: 2 }, [], {
      db: database,
      notifier: collectNotifier(dispatched),
      config: configWith(0.5),
      failedSummary: 'egov sync run failed',
    });
    const failed = dispatched.find((d) => d.kind === 'run_failed');
    expect(failed?.summary).toBe('egov sync run failed');
  });

  it('finalizeSyncRun dispatches threshold_exceeded on a partial run over threshold', async () => {
    const dispatched: NotificationPayload[] = [];
    const handle = begin();
    // 1/3 failed > 0.1 threshold, but captured>0 so the run is "partial", not "failed".
    const { summaryOutcome } = await finalizeSyncRun(
      handle,
      { ...ZERO_TOTALS, discovered: 3, captured: 2, failed: 1 },
      [],
      {
        db: database,
        notifier: collectNotifier(dispatched),
        config: configWith(0.1),
        failedSummary: 'x',
      },
    );
    expect(summaryOutcome).toBe('partial');
    expect(dispatched.map((d) => d.kind)).toEqual(['threshold_exceeded']);
  });

  it('finalizeSyncRun stays silent under threshold and without a notifier', async () => {
    const dispatched: NotificationPayload[] = [];
    const handle = begin();
    await finalizeSyncRun(handle, { ...ZERO_TOTALS, discovered: 10, captured: 9, failed: 1 }, [], {
      db: database,
      notifier: collectNotifier(dispatched),
      config: configWith(0.5),
      failedSummary: 'x',
    });
    expect(dispatched).toEqual([]);
    // No-notifier path must not throw.
    const handle2 = begin();
    handle2.recordEvent({ datasetId: 'd', outcome: 'discovered' });
    await expect(
      finalizeSyncRun(handle2, { ...ZERO_TOTALS, discovered: 1, failed: 1 }, [], {
        db: database,
        config: configWith(0.5),
        failedSummary: 'x',
      }),
    ).resolves.toMatchObject({ summaryOutcome: 'failed' });
  });

  it('guardSyncRun returns the fn result on success', async () => {
    const handle = begin();
    const out = await guardSyncRun(handle, async () => {
      handle.end({ summaryOutcome: 'success', totals: ZERO_TOTALS, datasetEntries: [] });
      return 42;
    });
    expect(out).toBe(42);
  });

  it('guardSyncRun aborts (fails run + releases lock) on a generic error, then rethrows', async () => {
    const handle = begin();
    await expect(
      guardSyncRun(handle, async () => {
        throw new Error('discovery down');
      }),
    ).rejects.toThrow('discovery down');
    expect(new SyncRunsLockRepo(database).state().is_locked).toBe(0);
    expect(new SyncRunsRepo(database).get(handle.runId)?.summary_outcome).toBe('failed');
  });

  it('guardSyncRun rethrows LockContentionError WITHOUT aborting the handle', async () => {
    const handle = begin();
    await expect(
      guardSyncRun(handle, async () => {
        throw new LockContentionError('someone-else');
      }),
    ).rejects.toBeInstanceOf(LockContentionError);
    // The run was never aborted — its lock is still held and the row is not marked failed.
    expect(new SyncRunsLockRepo(database).state().is_locked).toBe(1);
    expect(new SyncRunsRepo(database).get(handle.runId)?.summary_outcome).toBeNull();
  });

  it('end carries notes through to manifest', () => {
    const handle = beginSyncRun({
      db: database,
      storeRoot,
      trigger: 'manual',
      scopeFilter: {},
      onOverlap: 'skip',
    });
    const r = handle.end({
      summaryOutcome: 'partial',
      totals: ZERO_TOTALS,
      datasetEntries: [],
      notes: 'partial-with-warnings',
    });
    const manifest = JSON.parse(readFileSync(r.manifestPath, 'utf-8'));
    expect(manifest.notes).toBe('partial-with-warnings');
  });
});
