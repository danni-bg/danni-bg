import type { Database } from 'bun:sqlite';
import type { DanniConfig, ScopeConfig } from '../config/schema.ts';
import { ulid } from '../lib/ids.ts';
import { nowIso } from '../lib/time.ts';
import { type Notifier, dispatchAndPersist } from '../notify/notifier.ts';
import { withTransaction } from '../store/db.ts';
import { type EventOutcome, SyncRunEventsRepo } from '../store/repos/sync-run-events.ts';
import { SyncRunsLockRepo } from '../store/repos/sync-runs-lock.ts';
import { type RunTrigger, type SummaryOutcome, SyncRunsRepo } from '../store/repos/sync-runs.ts';
import { type ManifestDatasetEntry, type ManifestTotals, writeManifest } from './writer.ts';

export interface SyncRunLifecycleOptions {
  db: Database;
  storeRoot: string;
  trigger: RunTrigger;
  scopeFilter: ScopeConfig;
  onOverlap: 'skip';
}

export interface SyncRunHandle {
  runId: string;
  startedAt: string;
  scopeFilter: ScopeConfig;
  trigger: RunTrigger;
  recordEvent(input: {
    datasetId: string;
    resourceId?: string | null | undefined;
    outcome: EventOutcome;
    bytes?: number | null | undefined;
    sha256?: string | null | undefined;
    failureReason?: string | null | undefined;
    httpStatus?: number | null | undefined;
  }): void;
  end(input: {
    summaryOutcome: SummaryOutcome;
    totals: ManifestTotals;
    datasetEntries: ManifestDatasetEntry[];
    notes?: string;
  }): { manifestPath: string };
  abort(reason: string): void;
}

export class LockContentionError extends Error {
  constructor(public readonly heldByRunId: string | null) {
    super(`sync-run lock is already held by ${heldByRunId ?? 'an unknown run'}`);
    this.name = 'LockContentionError';
  }
}

export function reapAbandonedRuns(db: Database, now: string = nowIso()): string[] {
  const runs = new SyncRunsRepo(db);
  const lock = new SyncRunsLockRepo(db);
  const stale = runs.abandonStale('previous run abandoned by process exit', now);
  if (stale.length > 0) lock.forceRelease();
  return stale.map((r) => r.id);
}

export function beginSyncRun(opts: SyncRunLifecycleOptions): SyncRunHandle {
  const { db, storeRoot, trigger, scopeFilter } = opts;

  reapAbandonedRuns(db);

  const runs = new SyncRunsRepo(db);
  const events = new SyncRunEventsRepo(db);
  const lock = new SyncRunsLockRepo(db);

  const runId = ulid();
  const startedAt = nowIso();

  const acquired = withTransaction(db, () => {
    if (!lock.tryAcquire(runId, startedAt)) return false;
    runs.create({ id: runId, trigger, scopeFilterJson: JSON.stringify(scopeFilter), startedAt });
    return true;
  });

  if (!acquired) {
    // Only `onOverlap: 'skip'` exists (spec 056 FR-389): a contended begin surfaces the lock holder
    // as a thrown `LockContentionError` for the caller to handle (exit 5 on the scheduled path).
    throw new LockContentionError(lock.state().held_by_run_id);
  }

  let ended = false;

  const handle: SyncRunHandle = {
    runId,
    startedAt,
    scopeFilter,
    trigger,
    recordEvent(input) {
      events.insert({
        runId,
        datasetId: input.datasetId,
        resourceId: input.resourceId ?? null,
        outcome: input.outcome,
        bytes: input.bytes ?? null,
        sha256: input.sha256 ?? null,
        failureReason: input.failureReason ?? null,
        httpStatus: input.httpStatus ?? null,
      });
    },
    end(input) {
      if (ended) throw new Error(`sync run ${runId} already ended`);
      ended = true;
      const endedAt = nowIso();
      const manifestPath = writeManifest(storeRoot, {
        manifestVersion: '1.0.0',
        runId,
        trigger,
        scopeFilter,
        startedAt,
        endedAt,
        summaryOutcome: input.summaryOutcome,
        totals: input.totals,
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        datasets: input.datasetEntries,
      });
      withTransaction(db, () => {
        runs.finalize({
          id: runId,
          endedAt,
          summaryOutcome: input.summaryOutcome,
          totals: input.totals,
          manifestPath,
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
        });
        lock.release(runId);
      });
      return { manifestPath };
    },
    abort(reason: string) {
      if (ended) return;
      ended = true;
      const endedAt = nowIso();
      withTransaction(db, () => {
        runs.appendNote(runId, `aborted: ${reason}`);
        runs.finalize({
          id: runId,
          endedAt,
          summaryOutcome: 'failed',
          totals: {
            discovered: 0,
            captured: 0,
            skippedUnchanged: 0,
            failed: 0,
            withdrawn: 0,
            outOfScope: 0,
          },
          manifestPath: null,
          notes: `aborted: ${reason}`,
        });
        lock.release(runId);
      });
    },
  };
  return handle;
}

export function failureRate(totals: ManifestTotals): number {
  const denom = Math.max(totals.discovered, 1);
  return totals.failed / denom;
}

export interface FinalizeSyncRunDeps {
  db: Database;
  notifier?: Notifier | undefined;
  config: DanniConfig;
  /** Run-specific summary for the `run_failed` notification: `'sync run failed'` (CKAN) vs
   * `'egov sync run failed'` — the ONLY per-runner difference in the shared epilogue. */
  failedSummary: string;
}

/**
 * The shared sync-runner epilogue (spec 055 FR-371): derive the run's `summaryOutcome`, finalize the
 * handle (write the manifest + release the lock), and dispatch the `run_failed` / `threshold_exceeded`
 * notification. Both portal orchestrators (`runSync`, `runEgovSyncRun`) call this, so the outcome
 * ternary + notifier policy live in exactly one place next to the shared prelude (`beginSyncRun`).
 */
export async function finalizeSyncRun(
  handle: SyncRunHandle,
  totals: ManifestTotals,
  datasetEntries: ManifestDatasetEntry[],
  deps: FinalizeSyncRunDeps,
): Promise<{ summaryOutcome: SummaryOutcome; manifestPath: string }> {
  const summaryOutcome: SummaryOutcome =
    totals.failed === 0
      ? 'success'
      : totals.captured + totals.skippedUnchanged > 0
        ? 'partial'
        : 'failed';

  const finalize = handle.end({ summaryOutcome, totals, datasetEntries });

  if (deps.notifier) {
    const rate = failureRate(totals);
    if (summaryOutcome === 'failed') {
      await dispatchAndPersist(
        { db: deps.db, notifier: deps.notifier },
        {
          runId: handle.runId,
          kind: 'run_failed',
          summary: deps.failedSummary,
          totals: totals as unknown as Record<string, number>,
          failureRate: rate,
        },
      );
    } else if (rate > deps.config.schedule.failureRateThreshold) {
      await dispatchAndPersist(
        { db: deps.db, notifier: deps.notifier },
        {
          runId: handle.runId,
          kind: 'threshold_exceeded',
          summary: `failure rate ${rate.toFixed(3)} exceeded threshold ${deps.config.schedule.failureRateThreshold}`,
          totals: totals as unknown as Record<string, number>,
          failureRate: rate,
          threshold: deps.config.schedule.failureRateThreshold,
        },
      );
    }
  }

  return { summaryOutcome, manifestPath: finalize.manifestPath };
}

/**
 * The shared sync-runner catch tail (spec 055 FR-372): run `fn`, re-throwing a `LockContentionError`
 * untouched (the run never started — nothing to abort) and otherwise aborting the handle (marks the
 * run failed + releases the lock) before re-throwing. Wraps the body of both portal orchestrators so
 * the abort/rethrow policy exists once.
 */
export async function guardSyncRun<T>(handle: SyncRunHandle, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof LockContentionError) {
      throw err;
    }
    handle.abort(err instanceof Error ? err.message : String(err));
    throw err;
  }
}
