import type { Database } from 'bun:sqlite';
import type { DanniConfig } from '../config/schema.ts';
import { nowIso } from '../lib/time.ts';
import { withContext } from '../logging/logger.ts';
import { beginSyncRun, finalizeSyncRun, guardSyncRun } from '../manifest/sync-run.ts';
import type {
  ManifestDatasetEntry,
  ManifestResourceEntry,
  ManifestTotals,
} from '../manifest/writer.ts';
import type { Notifier } from '../notify/notifier.ts';
import { BlobStore } from '../store/blob-store.ts';
import type { RunTrigger } from '../store/repos/sync-runs.ts';
import { captureDataset } from './capture-dataset.ts';
import { captureResource } from './capture-resource.ts';
import type { CkanClient } from './ckan-client.ts';
import { discoverDatasets } from './discover.ts';
import type { PortalHttp } from './http.ts';
import { reconcileOutOfScope } from './out-of-scope.ts';
import { assertScopeSupported, buildScopePredicate } from './scope.ts';
import { detectWithdrawals } from './withdrawn.ts';

export interface RunSyncOptions {
  db: Database;
  config: DanniConfig;
  client: CkanClient;
  http: PortalHttp;
  storeRoot: string;
  trigger: RunTrigger;
  scopeFilterOverride?: DanniConfig['scope'];
  notifier?: Notifier;
  dryRun?: boolean;
  manifestOutOverride?: string;
  /** Called after a successful run with the dataset_ids touched (FR-015 incremental index). */
  onTouchedDatasets?: (datasetIds: string[]) => Promise<void> | void;
}

export interface RunSyncResult {
  runId: string;
  summaryOutcome: 'success' | 'partial' | 'failed';
  totals: ManifestTotals;
  manifestPath: string | null;
}

export async function runSync(opts: RunSyncOptions): Promise<RunSyncResult> {
  const scope = opts.scopeFilterOverride ?? opts.config.scope;
  // Scope semantics are adapter-independent (spec 048, FR-302): CKAN expresses all four scope
  // fields, so this never throws today — it keeps the "no field is silently dropped" guarantee
  // symmetric across adapters and fails loud if an unsupported field is ever added.
  assertScopeSupported(scope, 'ckan');
  const scopePredicate = buildScopePredicate(scope);
  const blobStore = new BlobStore({ storeRoot: opts.storeRoot });

  const handle = beginSyncRun({
    db: opts.db,
    storeRoot: opts.storeRoot,
    trigger: opts.trigger,
    scopeFilter: scope,
    onOverlap: opts.config.schedule.onOverlap,
  });
  const log = withContext({ run_id: handle.runId });
  log.info('sync.started', { trigger: opts.trigger });

  const totals: ManifestTotals = {
    discovered: 0,
    captured: 0,
    skippedUnchanged: 0,
    failed: 0,
    withdrawn: 0,
    outOfScope: 0,
  };

  const datasetEntries: ManifestDatasetEntry[] = [];
  const observedDatasetIds = new Set<string>();

  return guardSyncRun(handle, async () => {
    for await (const summary of discoverDatasets({
      client: opts.client,
      scopePredicate,
    })) {
      observedDatasetIds.add(summary.id);
      totals.discovered += 1;
      handle.recordEvent({ datasetId: summary.id, outcome: 'discovered' });

      const captured = await captureDataset(
        {
          db: opts.db,
          client: opts.client,
          runId: handle.runId,
          portalBaseUrl: opts.config.portal.baseUrl,
        },
        summary.id,
      );

      const resourceEntries: ManifestResourceEntry[] = [];
      let datasetOutcome: 'captured' | 'skipped_unchanged' | 'failed' = 'skipped_unchanged';

      for (const resource of captured.resources) {
        if (opts.dryRun) {
          handle.recordEvent({
            datasetId: summary.id,
            resourceId: resource.id,
            outcome: 'discovered',
          });
          resourceEntries.push({
            resourceId: resource.id,
            sourceUrl: resource.source_url,
            outcome: 'skipped_unchanged',
            ...(resource.declared_format ? { declaredFormat: resource.declared_format } : {}),
          });
          continue;
        }
        try {
          const result = await captureResource(
            { db: opts.db, http: opts.http, blobStore, storeRoot: opts.storeRoot },
            resource,
          );
          if (result.kind === 'captured') {
            totals.captured += 1;
            datasetOutcome = 'captured';
            handle.recordEvent({
              datasetId: summary.id,
              resourceId: resource.id,
              outcome: 'captured',
              bytes: result.bytes,
              sha256: result.sha256,
              httpStatus: result.httpStatus,
            });
            resourceEntries.push({
              resourceId: resource.id,
              sourceUrl: resource.source_url,
              outcome: 'captured',
              bytes: result.bytes,
              sha256: result.sha256,
              rawPath: result.rawPath,
              ...(resource.declared_format ? { declaredFormat: resource.declared_format } : {}),
              ...(result.etag ? { etag: result.etag } : {}),
              ...(result.lastModified ? { lastModified: result.lastModified } : {}),
              httpStatus: result.httpStatus,
            });
          } else if (result.kind === 'skipped_unchanged') {
            totals.skippedUnchanged += 1;
            handle.recordEvent({
              datasetId: summary.id,
              resourceId: resource.id,
              outcome: 'skipped_unchanged',
              httpStatus: result.httpStatus,
            });
            resourceEntries.push({
              resourceId: resource.id,
              sourceUrl: resource.source_url,
              outcome: 'skipped_unchanged',
              httpStatus: result.httpStatus,
              ...(resource.declared_format ? { declaredFormat: resource.declared_format } : {}),
            });
          } else {
            totals.failed += 1;
            handle.recordEvent({
              datasetId: summary.id,
              resourceId: resource.id,
              outcome: 'failed',
              failureReason: result.reason,
              ...(result.httpStatus !== undefined ? { httpStatus: result.httpStatus } : {}),
            });
            resourceEntries.push({
              resourceId: resource.id,
              sourceUrl: resource.source_url,
              outcome: 'failed',
              failureReason: result.reason,
              ...(result.httpStatus !== undefined ? { httpStatus: result.httpStatus } : {}),
              ...(resource.declared_format ? { declaredFormat: resource.declared_format } : {}),
            });
          }
        } catch (err) {
          totals.failed += 1;
          const reason = err instanceof Error ? err.message : String(err);
          handle.recordEvent({
            datasetId: summary.id,
            resourceId: resource.id,
            outcome: 'failed',
            failureReason: reason,
          });
          resourceEntries.push({
            resourceId: resource.id,
            sourceUrl: resource.source_url,
            outcome: 'failed',
            failureReason: reason,
          });
        }
      }

      datasetEntries.push({
        datasetId: summary.id,
        sourceUrl: captured.pkg.name
          ? `${opts.config.portal.baseUrl.replace(/\/api\/?\d?\/?action\/?$/, '').replace(/\/$/, '')}/data/dataset/${captured.pkg.name}`
          : opts.config.portal.baseUrl,
        outcome: datasetOutcome,
        lifecycleState: 'active',
        capturedAt: nowIso(),
        metadataHash: captured.metadataHash,
        resources: resourceEntries,
      });
    }

    const withdrawals = detectWithdrawals({
      db: opts.db,
      runId: handle.runId,
      observedDatasetIds,
    });
    for (const w of withdrawals) {
      totals.withdrawn += 1;
      handle.recordEvent({ datasetId: w.datasetId, outcome: 'withdrawn', failureReason: w.reason });
    }

    const outOfScope = reconcileOutOfScope({
      db: opts.db,
      runId: handle.runId,
      scopePredicate,
    });
    for (const o of outOfScope) {
      totals.outOfScope += 1;
      handle.recordEvent({ datasetId: o.datasetId, outcome: 'out_of_scope' });
    }

    const { summaryOutcome, manifestPath } = await finalizeSyncRun(handle, totals, datasetEntries, {
      db: opts.db,
      notifier: opts.notifier,
      config: opts.config,
      failedSummary: 'sync run failed',
    });

    if (opts.onTouchedDatasets && observedDatasetIds.size > 0) {
      try {
        await opts.onTouchedDatasets([...observedDatasetIds]);
      } catch (err) {
        log.warn('sync.index_hook_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    log.info('sync.ended', { summaryOutcome, ...totals });
    return {
      runId: handle.runId,
      summaryOutcome,
      totals,
      manifestPath,
    };
  });
}
