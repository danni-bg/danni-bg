import type { Database } from 'bun:sqlite';
import type { ScopeConfig } from '../config/schema.ts';
import { withContext } from '../logging/logger.ts';
import { CheckpointCorruptError, CrawlCheckpointsRepo } from '../store/repos/crawl-checkpoints.ts';
import type { EgovBgClient } from './egov-bg-client.ts';
import { computeScopeHash } from './scope-hash.ts';
import { egovSummaryInScope } from './scope.ts';

const PAGE_SIZE = 100;

/**
 * Resume planner for the egov crawl (FR-001/2/3/4, FR-008, research.md R2/R3/R8). Builds or loads
 * a campaign (the frozen sorted in-scope dataset-uri list keyed by scope-hash), produces a
 * per-session ordered plan after the cursor, decides skip/fetch per dataset, reconciles catalog
 * additions, and degrades to a safe re-scan on a lost/corrupt checkpoint.
 */

export interface BuildCampaignOptions {
  db: Database;
  client: EgovBgClient;
  scope: ScopeConfig;
}

export interface CampaignHandle {
  scopeHash: string;
  /** true when this invocation created the campaign row (first session). */
  created: boolean;
  /** true when the checkpoint was missing/corrupt and was rebuilt (FR-008 degradation). */
  degraded: boolean;
}

/**
 * Enumerate the in-scope dataset-uri set once by paging listDatasets (FR-003, research R2). The
 * campaign is frozen to only in-scope uris (spec 048, FR-300/303): a `datasetIds` scope bypasses
 * discovery, and otherwise each `listDatasets` summary is filtered by `egovSummaryInScope` so a
 * publisher scope freezes only that publisher's uris instead of the whole portal. Tags (absent
 * from the summary) are resolved at processing time (FR-301), so a tag scope keeps candidates here.
 */
async function enumerateUris(client: EgovBgClient, scope: ScopeConfig): Promise<string[]> {
  if (scope.datasetIds && scope.datasetIds.length > 0) {
    return [...scope.datasetIds].sort();
  }
  const uris: string[] = [];
  let page = 1;
  for (;;) {
    const resp = await client.listDatasets({ recordsPerPage: PAGE_SIZE, pageNumber: page });
    for (const d of resp.datasets) {
      if (egovSummaryInScope(d, scope)) uris.push(d.uri);
    }
    if (resp.datasets.length < PAGE_SIZE) break;
    page++;
  }
  return [...uris].sort();
}

/**
 * Build the campaign on first run (enumerate + freeze) or load it on resume. On a lost or corrupt
 * checkpoint, degrade to a safe re-scan: drop the bad row and rebuild from a fresh enumeration
 * (FR-008). The on-disk content reuse that avoids re-downloading is enforced at capture time.
 */
export async function buildOrLoadCampaign(opts: BuildCampaignOptions): Promise<CampaignHandle> {
  const repo = new CrawlCheckpointsRepo(opts.db);
  const log = withContext({ component: 'crawl-checkpoint' });
  const { scopeHash, canonical } = computeScopeHash(opts.scope);

  const existing = repo.getCampaign(scopeHash);
  if (existing) {
    // Validate the persisted JSON; a corrupt row degrades to a safe re-scan (FR-008, R8).
    try {
      repo.frozenIds(scopeHash);
      repo.scope(scopeHash);
      return { scopeHash, created: false, degraded: false };
    } catch (err) {
      if (err instanceof CheckpointCorruptError) {
        log.warn('checkpoint.corrupt.rescan', { scopeHash, error: err.message });
        repo.deleteCampaign(scopeHash);
      } else {
        throw err;
      }
    }
    const uris = await enumerateUris(opts.client, opts.scope);
    repo.createCampaign({ scopeHash, scopeJson: canonical, frozenIds: uris });
    return { scopeHash, created: true, degraded: true };
  }

  const uris = await enumerateUris(opts.client, opts.scope);
  repo.createCampaign({ scopeHash, scopeJson: canonical, frozenIds: uris });
  return { scopeHash, created: true, degraded: false };
}

export interface PlanSessionOptions {
  db: Database;
  scopeHash: string;
  /** Per-session dataset batch cap (FR-003). */
  max?: number | undefined;
  /** Re-include sub-cap failed datasets (FR-009). */
  retryFailed?: boolean | undefined;
}

export interface SessionPlan {
  /** Ordered dataset uris to process this session (after the cursor, batch-bounded). */
  uris: string[];
  /** true when the cursor has passed the last frozen id and no work remains. */
  completed: boolean;
}

/**
 * Produce the ordered list of dataset uris to process this session, in frozen order:
 * - every frozen uri strictly after the cursor that is NOT a recorded failure, plus
 * - when `retryFailed` is set, every sub-cap recorded failure anywhere in the frozen list
 *   (failures may sit BEFORE the cursor once it advanced past them — FR-009).
 * Bounded by `max`. When nothing is eligible, the session is complete.
 */
export function planSession(opts: PlanSessionOptions): SessionPlan {
  const repo = new CrawlCheckpointsRepo(opts.db);
  const campaign = repo.getCampaign(opts.scopeHash);
  if (!campaign) return { uris: [], completed: true };
  const frozen = repo.frozenIds(opts.scopeHash);
  const cursor = campaign.cursor_uri;
  // -1 (cursor vanished) → startIdx 0 so the whole list is reconsidered.
  const cursorIdx = cursor === null ? -1 : frozen.indexOf(cursor);

  const eligible: string[] = [];
  for (let i = 0; i < frozen.length; i++) {
    const uri = frozen[i] as string;
    const ds = repo.getDataset(opts.scopeHash, uri);
    const isFailed = ds?.outcome === 'failed';
    if (isFailed) {
      const capped = (ds?.attempts ?? 0) >= campaign.max_attempts;
      if (opts.retryFailed && !capped) {
        eligible.push(uri); // retryable failure, regardless of cursor position
      }
      if (opts.max !== undefined && eligible.length >= opts.max) break;
      continue; // a failure is never re-run on a normal resume
    }
    if (i > cursorIdx) {
      eligible.push(uri); // unvisited / pending / complete-but-after-cursor work
      if (opts.max !== undefined && eligible.length >= opts.max) break;
    }
  }

  return { uris: eligible, completed: eligible.length === 0 };
}

export interface DatasetSkipOptions {
  db: Database;
  scopeHash: string;
  datasetUri: string;
  /** Freshly computed dataset-level validator. */
  validator: string;
}

/**
 * Decide whether a dataset can be skipped on resume (FR-002, research R3): the stored validator
 * must equal the fresh one AND every resource row must be `success` under that validator. A
 * never-visited dataset, a validator change, a not-yet-success resource, or a dataset whose
 * recorded resource_count doesn't match its success rows → fetch.
 */
export function decideDatasetSkip(opts: DatasetSkipOptions): boolean {
  const repo = new CrawlCheckpointsRepo(opts.db);
  const ds = repo.getDataset(opts.scopeHash, opts.datasetUri);
  if (!ds) return false;
  if (ds.validator !== opts.validator) return false;
  const resources = repo.listResources(opts.scopeHash, opts.datasetUri);
  if (resources.length === 0) return false; // never captured any resource → not safely complete
  return resources.every((r) => r.outcome === 'success' && r.validator === opts.validator);
}

export interface ReconcileOptions {
  db: Database;
  client: EgovBgClient;
  scope: ScopeConfig;
  scopeHash: string;
}

/**
 * Reconcile the frozen list against the live catalog (FR-004, research R2): re-enumerate, append
 * any new uris (never reorder), and stamp `reconciled_at`. Returns the newly appended uris so the
 * caller can route vanished uris through withdrawal handling. Because the cursor advances over a
 * stable sorted order, reordering between sessions never skips a dataset.
 */
export async function reconcileCatalog(opts: ReconcileOptions): Promise<{
  added: string[];
  vanished: string[];
}> {
  const repo = new CrawlCheckpointsRepo(opts.db);
  const live = await enumerateUris(opts.client, opts.scope);
  const frozen = new Set(repo.frozenIds(opts.scopeHash));
  const liveSet = new Set(live);
  const added = live.filter((uri) => !frozen.has(uri));
  const vanished = [...frozen].filter((uri) => !liveSet.has(uri));
  if (added.length > 0) repo.appendFrozenIds(opts.scopeHash, added);
  return { added, vanished };
}

export interface PrepareSessionOptions {
  db: Database;
  client: EgovBgClient;
  scope: ScopeConfig;
  scopeHash: string;
  retryFailed?: boolean | undefined;
}

export interface PreparedSession {
  /** uris that vanished upstream since the campaign was frozen (route to withdrawal). */
  vanished: string[];
}

/**
 * Prepare a session over an existing campaign (FR-004, data-model §3.3). When the campaign is
 * already `completed`, a re-invocation re-walks the full frozen list to catch upstream validator
 * changes (FR-002) and reconciles the catalog (append additions, surface removals) — the cursor is
 * reset so the re-walk covers every dataset; datasets whose validator is unchanged AND whose
 * resources are all captured are skipped at processing time (zero re-download — SC-005). On an
 * active (mid-campaign) session this is a no-op so a bounded resume advances normally.
 */
export async function prepareSession(opts: PrepareSessionOptions): Promise<PreparedSession> {
  const repo = new CrawlCheckpointsRepo(opts.db);
  const campaign = repo.getCampaign(opts.scopeHash);
  if (!campaign) return { vanished: [] };
  if (campaign.status !== 'completed') return { vanished: [] };

  // Completed campaign re-invoked: reconcile the catalog, re-activate, and reset the cursor so the
  // whole frozen list is re-walked (validator recheck + new datasets). retryFailed re-opens
  // sub-cap failures (handled by runEgovSync); reconcile picks up additions/removals.
  const { vanished } = await reconcileCatalog({
    db: opts.db,
    client: opts.client,
    scope: opts.scope,
    scopeHash: opts.scopeHash,
  });
  repo.markCampaignActive(opts.scopeHash);
  // Reset the cursor to NULL so planSession yields the full frozen list for a re-walk.
  opts.db
    .query('UPDATE crawl_checkpoints SET cursor_uri = NULL WHERE scope_hash = ?')
    .run(opts.scopeHash);
  return { vanished };
}
