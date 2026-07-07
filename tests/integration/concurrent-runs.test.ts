import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LockContentionError, beginSyncRun } from '../../src/manifest/sync-run.ts';
import { openDb } from '../../src/store/db.ts';
import { runMigrations } from '../../src/store/migrate.ts';
import { SyncRunsLockRepo } from '../../src/store/repos/sync-runs-lock.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

describe('integration.concurrent-runs', () => {
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

  it('with onOverlap=skip a contended begin throws LockContentionError', () => {
    new SyncRunsLockRepo(db).tryAcquire('held-by-another');
    expect(() =>
      beginSyncRun({
        db,
        storeRoot,
        trigger: 'manual',
        scopeFilter: {},
        onOverlap: 'skip',
      }),
    ).toThrow(LockContentionError);
  });

  it('after a clean release the next begin succeeds', () => {
    const lock = new SyncRunsLockRepo(db);
    lock.tryAcquire('previous');
    lock.release('previous');
    const handle = beginSyncRun({
      db,
      storeRoot,
      trigger: 'manual',
      scopeFilter: {},
      onOverlap: 'skip',
    });
    expect(handle.runId).toBeDefined();
    handle.end({
      summaryOutcome: 'success',
      totals: {
        discovered: 0,
        captured: 0,
        skippedUnchanged: 0,
        failed: 0,
        withdrawn: 0,
        outOfScope: 0,
      },
      datasetEntries: [],
    });
  });
});
