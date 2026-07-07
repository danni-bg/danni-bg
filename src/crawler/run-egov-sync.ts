import type { Database } from 'bun:sqlite';
import type { DanniConfig, ScopeConfig } from '../config/schema.ts';
import { withContext } from '../logging/logger.ts';
import { beginSyncRun, finalizeSyncRun, guardSyncRun } from '../manifest/sync-run.ts';
import type { ManifestTotals } from '../manifest/writer.ts';
import type { Notifier } from '../notify/notifier.ts';
import { CrawlCheckpointsRepo } from '../store/repos/crawl-checkpoints.ts';
import { DatasetsRepo } from '../store/repos/datasets.ts';
import { ResourcesRepo } from '../store/repos/resources.ts';
import type { RunTrigger } from '../store/repos/sync-runs.ts';
import { buildOrLoadCampaign, planSession, prepareSession } from './crawl-checkpoint.ts';
import type { EgovBgClient } from './egov-bg-client.ts';
import { runEgovSync } from './egov-sync.ts';
import { assertScopeSupported } from './scope.ts';

/**
 * Orchestrator for the resumable egov crawl (FR-007, research.md R4) — mirrors `runSync`
 * (`run-sync.ts`). Acquires the single `sync_runs_lock` via `beginSyncRun` (egov & CKAN mutually
 * exclusive), builds/loads the campaign checkpoint, plans the per-session dataset batch, drives
 * `runEgovSync` with the handle, then finalizes + dispatches the notifier via the shared
 * `finalizeSyncRun` epilogue. The body is wrapped in `guardSyncRun`, which re-throws a
 * `LockContentionError` to the caller (CLI → exit 5) and otherwise aborts the handle (spec 055).
 */

export interface RunEgovSyncRunOptions {
  db: Database;
  config: DanniConfig;
  client: EgovBgClient;
  storeRoot: string;
  trigger: RunTrigger;
  scope: ScopeConfig;
  notifier?: Notifier | undefined;
  /** Per-session dataset batch cap (FR-003). */
  max?: number | undefined;
  /** Re-attempt sub-cap recorded failures (FR-009). */
  retryFailed?: boolean | undefined;
  locale?: string | undefined;
}

export interface RunEgovSyncRunResult {
  runId: string;
  scopeHash: string;
  summaryOutcome: 'success' | 'partial' | 'failed';
  totals: ManifestTotals;
  manifestPath: string | null;
  completed: boolean;
}

/**
 * Mark uris that vanished from the live catalog as withdrawn (FR-004 / 001 withdrawal rules):
 * the dataset + its resources flip to `withdrawn` (rows + raw bytes preserved) and a `withdrawn`
 * event is recorded. Only datasets already captured (with a `datasets` row) are touched.
 */
function handleWithdrawals(
  db: Database,
  handle: {
    recordEvent: (i: { datasetId: string; outcome: 'withdrawn'; failureReason?: string }) => void;
  },
  vanished: string[],
): number {
  const datasets = new DatasetsRepo(db);
  const resources = new ResourcesRepo(db);
  let count = 0;
  for (const uri of vanished) {
    const row = datasets.get(uri);
    if (!row || row.lifecycle_state === 'withdrawn') continue;
    datasets.setLifecycle(uri, 'withdrawn', 'absent from discovery');
    for (const r of resources.listByDataset(uri)) resources.setLifecycle(r.id, 'withdrawn');
    handle.recordEvent({
      datasetId: uri,
      outcome: 'withdrawn',
      failureReason: 'absent from discovery',
    });
    count++;
  }
  return count;
}

export async function runEgovSyncRun(opts: RunEgovSyncRunOptions): Promise<RunEgovSyncRunResult> {
  const checkpoint = new CrawlCheckpointsRepo(opts.db);

  // Fail loudly BEFORE acquiring the lock / touching the portal if the scope names a field the
  // egov adapter can't express (spec 048, FR-302) — no capture happens on an unsupported scope.
  assertScopeSupported(opts.scope, 'egov-bg');

  const handle = beginSyncRun({
    db: opts.db,
    storeRoot: opts.storeRoot,
    trigger: opts.trigger,
    scopeFilter: opts.scope,
    onOverlap: opts.config.schedule.onOverlap,
  });
  const log = withContext({ run_id: handle.runId, component: 'run-egov-sync' });
  log.info('egov-sync.started', { trigger: opts.trigger });

  return guardSyncRun(handle, async () => {
    const campaign = await buildOrLoadCampaign({
      db: opts.db,
      client: opts.client,
      scope: opts.scope,
    });
    const { scopeHash } = campaign;

    // A re-invoked completed campaign re-walks for validator changes + catalog drift (FR-004); an
    // active session is a no-op here. Vanished uris are routed through the withdrawal path.
    const prepared = await prepareSession({
      db: opts.db,
      client: opts.client,
      scope: opts.scope,
      scopeHash,
      retryFailed: opts.retryFailed,
    });
    const withdrawn = handleWithdrawals(opts.db, handle, prepared.vanished);

    const plan = planSession({
      db: opts.db,
      scopeHash,
      max: opts.max,
      retryFailed: opts.retryFailed,
    });

    const result = await runEgovSync({
      db: opts.db,
      storeRoot: opts.storeRoot,
      client: opts.client,
      handle,
      scopeHash,
      scope: opts.scope,
      uris: plan.uris,
      ...(opts.retryFailed !== undefined ? { retryFailed: opts.retryFailed } : {}),
      ...(opts.locale !== undefined ? { locale: opts.locale } : {}),
    });
    result.totals.withdrawn += withdrawn;

    // Campaign completion: the cursor has passed the last frozen id with no retry-eligible
    // failures remaining (FR-003, US2). A completed campaign short-circuits future sessions.
    const remainingAfter = planSession({ db: opts.db, scopeHash });
    let completed = false;
    if (
      remainingAfter.uris.length === 0 &&
      checkpoint.listRetryableFailed(scopeHash).length === 0
    ) {
      checkpoint.markCampaignCompleted(scopeHash);
      completed = true;
    }

    const { summaryOutcome, manifestPath } = await finalizeSyncRun(
      handle,
      result.totals,
      result.datasetEntries,
      {
        db: opts.db,
        notifier: opts.notifier,
        config: opts.config,
        failedSummary: 'egov sync run failed',
      },
    );

    log.info('egov-sync.ended', { summaryOutcome, completed, ...result.totals });
    return {
      runId: handle.runId,
      scopeHash,
      summaryOutcome,
      totals: result.totals,
      manifestPath,
      completed,
    };
  });
}
