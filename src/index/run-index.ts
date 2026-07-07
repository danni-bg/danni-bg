import type { Database } from 'bun:sqlite';
import { effectiveBatchSize } from '../config/schema.ts';
import { withContext } from '../logging/logger.ts';
import { withTransaction } from '../store/db.ts';
import { type DatasetRow, DatasetsRepo } from '../store/repos/datasets.ts';
import { IndexFailuresRepo } from '../store/repos/index-failures.ts';
import { type BatchProgress, type EmbedPair, type NotEmbedded, embedBatch } from './batch-embed.ts';
import type { Embedder } from './embedder.ts';
import {
  bumpEmbeddingsMeta,
  deleteEmbedding,
  ensureEmbeddingsTable,
  getEmbeddingsMeta,
  setEmbeddingsMeta,
  upsertEmbedding,
} from './embeddings-store.ts';
import { buildFtsRow, deleteFtsRow, upsertFtsRow } from './fts.ts';
import { IndexStateRepo, contentFp, embedFp, modelIdOf } from './index-state.ts';
import { composeEmbeddingText } from './vec.ts';

export interface RunIndexOptions {
  db: Database;
  embedder: Embedder;
  datasetIds?: string[];
  full?: boolean;
  /** Incremental skip gate enabled when truthy/undefined; `--full` overrides this. */
  incremental?: boolean;
  /** Configured texts-per-embedder-request (002, FR-002); defaults to 32. */
  batchSize?: number;
  /** Optional config cap on the batch size (002, FR-002). */
  maxBatchSize?: number | null;
  /** Injectable backoff sleep seam for the batcher (002, FR-009); 0-delay in tests. */
  delay?: (ms: number) => Promise<void>;
  /** Per-batch progress sink (002, FR-010). */
  onProgress?: (p: BatchProgress) => void;
}

export interface RunIndexResult {
  ftsUpdated: number;
  vectorsUpdated: number;
  /** Datasets embedded because content changed / new / presence-guard (FR-007). */
  embedded: number;
  /** Datasets whose FTS+vector were both skipped this run (FR-007). */
  skippedUnchanged: number;
  /** Datasets re-embedded solely because the embedder identity changed (FR-007). */
  reembeddedDueToModelChange: number;
  /** Datasets purged from the index because they are no longer active (FR-006/FR-007). */
  purged: number;
  /** Every embedder invocation, incl. single-text retries and forced-single (002, FR-008). */
  embedderRequests: number;
  /** Datasets excluded for empty composed text (002, FR-007/FR-008). */
  skippedEmpty: number;
  /** Datasets still un-embedded after the single-text retry (002, FR-004/FR-008). */
  failed: number;
  /** In-memory mirror of the persisted index_failures rows (002, FR-008). */
  failures: NotEmbedded[];
}

const DEFAULT_BATCH_SIZE = 32;

function ftsRowPresent(db: Database, datasetId: string): boolean {
  return (
    db
      .query<{ one: number }, [string]>('SELECT 1 AS one FROM datasets_fts WHERE dataset_id = ?')
      .get(datasetId) !== null
  );
}

function embeddingRowPresent(db: Database, datasetId: string): boolean {
  return (
    db
      .query<{ one: number }, [string]>(
        'SELECT 1 AS one FROM dataset_embeddings WHERE dataset_id = ?',
      )
      .get(datasetId) !== null
  );
}

interface Counters {
  ftsUpdated: number;
  vectorsUpdated: number;
  embedded: number;
  skippedUnchanged: number;
  reembeddedDueToModelChange: number;
  purged: number;
  embedderRequests: number;
  skippedEmpty: number;
  failed: number;
  failures: NotEmbedded[];
}

/**
 * The "embed-the-set" SEAM (002, plan.md §Cross-Spec Coordination). 003 decides WHICH datasets
 * need a vector (and tags each `content-changed` vs `model-changed`); this carries that decision
 * to the batcher. `embed_fp`/`model_id` are pre-computed under 003's gate so the persisted vector
 * writes them exactly as the one-at-a-time loop did.
 */
interface VectorWork {
  datasetId: string;
  text: string;
  embedFp: string;
  modelChange: boolean;
}

/**
 * Batch-embed the changed/selected set and persist each vector with its `embed_fp`/`model_id`
 * (002 SEAM). The batcher (`embedBatch`) is PURE — it returns vectors; this loop OWNS all
 * persistence: per landed vector it writes `upsertEmbedding` + `IndexStateRepo.upsertEmbed` in a
 * per-dataset transaction, clears `index_failures`, and attributes the vector to 003's `embedded`
 * (content-changed) or `reembeddedDueToModelChange` (model-changed) counter by the pair's tag. Per
 * `failures[]` entry it records `index_failures`. FTS upserts stay per-dataset and OUTSIDE this
 * path (FR-010); 003's skip gate and transaction ordering are untouched.
 */
async function embedAndPersist(
  opts: RunIndexOptions,
  work: VectorWork[],
  currentModelId: string,
  indexState: IndexStateRepo,
  indexFailures: IndexFailuresRepo,
  c: Counters,
): Promise<void> {
  const db = opts.db;
  const byId = new Map(work.map((w) => [w.datasetId, w]));
  const pairs: EmbedPair[] = work.map((w) => ({ datasetId: w.datasetId, text: w.text }));
  const eff = effectiveBatchSize(
    opts.batchSize ?? DEFAULT_BATCH_SIZE,
    opts.maxBatchSize,
    opts.embedder.maxBatchSize,
  );

  const result = await embedBatch(pairs, opts.embedder, eff, {
    ...(opts.delay ? { delay: opts.delay } : {}),
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    onVector: ({ datasetId, vector }) => {
      const w = byId.get(datasetId);
      if (!w) return;
      withTransaction(db, () => {
        upsertEmbedding(db, datasetId, vector);
        indexState.upsertEmbed(datasetId, w.embedFp, currentModelId);
      });
      indexFailures.clear(datasetId);
      c.vectorsUpdated++;
      if (w.modelChange) c.reembeddedDueToModelChange++;
      else c.embedded++;
    },
  });

  c.embedderRequests += result.embedderRequests;
  c.skippedEmpty += result.skippedEmpty;
  c.failed += result.failed;
  for (const f of result.failures) {
    indexFailures.record(f.datasetId, f.reason);
    c.failures.push(f);
  }
}

/**
 * Full force-rebuild (FR-005, research.md R7): clear all stores then re-derive every active
 * dataset's FTS row + vector + fresh index_state, ignoring the skip gate. The vector leg is now
 * BATCHED (002): FTS rows and `content_fp` are written first (per-dataset, outside batching), then
 * the non-empty texts are handed to the batcher and each returned vector persisted.
 */
async function rebuildFull(
  opts: RunIndexOptions,
  active: DatasetRow[],
  currentModelId: string,
  indexState: IndexStateRepo,
  indexFailures: IndexFailuresRepo,
  c: Counters,
): Promise<void> {
  const db = opts.db;
  ensureEmbeddingsTable(db);
  // Clear all stores up front so a prior model's vectors/failures can never survive a --full.
  withTransaction(db, () => {
    db.exec('DELETE FROM datasets_fts');
    db.exec('DELETE FROM dataset_embeddings');
    db.exec('DELETE FROM index_state');
    db.exec('DELETE FROM index_failures');
  });

  const work: VectorWork[] = [];
  for (const ds of active) {
    const row = buildFtsRow(db, ds.id);
    if (!row) continue;
    withTransaction(db, () => {
      upsertFtsRow(db, row);
      indexState.upsertContent(row.dataset_id, contentFp(row));
      c.ftsUpdated++;
    });
    // Empty-text datasets are included so the batcher excludes them and records `empty_text`
    // (FR-007); non-empty ones become content-changed vector work (a --full re-derives all).
    const text = composeEmbeddingText(db, ds.id);
    work.push({ datasetId: ds.id, text, embedFp: embedFp(text), modelChange: false });
  }

  await embedAndPersist(opts, work, currentModelId, indexState, indexFailures, c);
}

export async function runIndex(opts: RunIndexOptions): Promise<RunIndexResult> {
  const log = withContext({ component: 'index' });
  const db = opts.db;
  const datasets = new DatasetsRepo(db);
  const indexState = new IndexStateRepo(db);
  const indexFailures = new IndexFailuresRepo(db);
  ensureEmbeddingsTable(db);

  const incremental = !opts.full && (opts.incremental ?? true);

  // Record the global embedder identity once at run start (research.md R8). The per-dataset
  // re-embed decision reads index_state.model_id, not this global marker, so a partial model
  // switch still converges; but the global marker is kept current for read consumers.
  const currentModelId = modelIdOf(opts.embedder);
  const meta = getEmbeddingsMeta(db);
  if (meta.model_id !== opts.embedder.id || meta.dimension !== opts.embedder.dimension) {
    setEmbeddingsMeta(db, opts.embedder.id, opts.embedder.dimension);
  }

  const active = datasets.listActive();

  const c: Counters = {
    ftsUpdated: 0,
    vectorsUpdated: 0,
    embedded: 0,
    skippedUnchanged: 0,
    reembeddedDueToModelChange: 0,
    purged: 0,
    embedderRequests: 0,
    skippedEmpty: 0,
    failed: 0,
    failures: [],
  };

  if (opts.full) {
    await rebuildFull(opts, active, currentModelId, indexState, indexFailures, c);
    reconcileOrphans(db, datasets, indexState, indexFailures, c);
    if (c.vectorsUpdated > 0 || c.purged > 0) bumpEmbeddingsMeta(db);
    log.info('index.completed', toLog(c, 'full'));
    return toResult(c);
  }

  // Resolve the recompute targets. A --datasets subset limits ONLY which datasets are
  // recomputed; the orphan purge below still runs full-corpus (FR-006).
  const targets =
    opts.datasetIds && opts.datasetIds.length > 0
      ? opts.datasetIds
          .map((id) => datasets.get(id))
          .filter((row): row is DatasetRow => row !== null && row.lifecycle_state === 'active')
      : active;

  // 003's per-dataset skip gate runs first and does the FTS leg inline (per-dataset, outside
  // batching, FR-010); it collects the SET of datasets needing a vector (tagged content vs model).
  const work: VectorWork[] = [];
  for (const ds of targets) {
    const row = buildFtsRow(db, ds.id);
    if (!row) continue;
    const state = indexState.get(ds.id);

    // --- Decide the changed/selected set (SEAM 002: this decision stays separate from the
    //     "embed the set" step so 002 batches the vector leg without rewriting the gate). ---
    const currentContentFp = contentFp(row);
    const text = composeEmbeddingText(db, ds.id);
    const currentEmbedFp = embedFp(text);

    const ftsSkip =
      incremental && state?.content_fp === currentContentFp && ftsRowPresent(db, ds.id);
    const hasText = text.trim() !== '';
    const embedMatches = state?.embed_fp === currentEmbedFp && state.model_id === currentModelId;
    const vecSkip = incremental && hasText && embedMatches && embeddingRowPresent(db, ds.id);

    if (ftsSkip && (vecSkip || !hasText)) {
      // Nothing to do for this dataset. (Empty-text datasets never carry a vector; once their
      // FTS row is current they are "unchanged".)
      c.skippedUnchanged++;
      continue;
    }

    // Pure model change vs content change (count-precedence, data-model §3): only a matching
    // embed_fp with a differing model_id is a "model change"; any embed_fp mismatch/NULL means
    // content changed and is counted as `embedded` even if the model also changed.
    const pureModelChange =
      incremental &&
      hasText &&
      !vecSkip &&
      state?.embed_fp === currentEmbedFp &&
      embeddingRowPresent(db, ds.id) &&
      state.model_id !== currentModelId;

    // FTS leg (cheap) stays per-dataset, inside its own transaction (003's ordering). content_fp
    // is never written without its FTS row.
    if (!ftsSkip) {
      withTransaction(db, () => {
        upsertFtsRow(db, row);
        indexState.upsertContent(ds.id, currentContentFp);
        c.ftsUpdated++;
      });
    }

    // Defer the embed to the batched seam: collect this dataset into the changed/selected set.
    // Empty-text datasets are included too (with their empty text) so the batcher excludes them
    // and records `empty_text` (FR-007); a present, matching vector (vecSkip) is left untouched.
    if (!vecSkip) {
      work.push({
        datasetId: ds.id,
        text,
        embedFp: currentEmbedFp,
        modelChange: pureModelChange,
      });
    }
  }

  // 002 SEAM (do NOT rewrite 003): 002 batches ONLY the changed/selected set 003's loop yielded
  // above. FTS upserts stay per-dataset and outside batching (FR-010); index_failures is cleared
  // on a successful embed and recorded on a per-text failure (FR-008); the orphan purge below also
  // clears index_failures for non-active datasets (T026). 003's skip gate is untouched.
  await embedAndPersist(opts, work, currentModelId, indexState, indexFailures, c);

  reconcileOrphans(db, datasets, indexState, indexFailures, c);

  // Advance the vector-cache stale token (spec 050 FR-321) whenever this run touched vectors, so a
  // running explorer/MCP reloads the corpus on its next query. Purge-only runs bump too: a removed
  // dataset must drop out of the resident matrix.
  if (c.vectorsUpdated > 0 || c.purged > 0) bumpEmbeddingsMeta(db);
  log.info('index.completed', toLog(c, 'incremental'));
  return toResult(c);
}

function toResult(c: Counters): RunIndexResult {
  return {
    ftsUpdated: c.ftsUpdated,
    vectorsUpdated: c.vectorsUpdated,
    embedded: c.embedded,
    skippedUnchanged: c.skippedUnchanged,
    reembeddedDueToModelChange: c.reembeddedDueToModelChange,
    purged: c.purged,
    embedderRequests: c.embedderRequests,
    skippedEmpty: c.skippedEmpty,
    failed: c.failed,
    failures: c.failures,
  };
}

function toLog(c: Counters, mode: 'full' | 'incremental'): Record<string, unknown> {
  return {
    mode,
    ftsUpdated: c.ftsUpdated,
    vectorsUpdated: c.vectorsUpdated,
    embedded: c.embedded,
    skippedUnchanged: c.skippedUnchanged,
    reembeddedDueToModelChange: c.reembeddedDueToModelChange,
    purged: c.purged,
    embedderRequests: c.embedderRequests,
    skippedEmpty: c.skippedEmpty,
    failed: c.failed,
  };
}

/**
 * Every-run orphan reconcile (FR-006, SC-004): delete every index row whose dataset_id is not in
 * listActive() from all index stores. Runs full-corpus even under a --datasets subset.
 *
 * SEAM (002): `index_failures` is the 4th store cleared here (plan.md §Cross-Spec Coordination
 * "Orphan purge co-ownership") — a withdrawn dataset's failure row must not linger.
 */
function reconcileOrphans(
  db: Database,
  datasets: DatasetsRepo,
  indexState: IndexStateRepo,
  indexFailures: IndexFailuresRepo,
  c: Counters,
): void {
  const activeIds = new Set(datasets.listActive().map((d) => d.id));
  const ftsIds = db
    .query<{ dataset_id: string }, []>('SELECT dataset_id FROM datasets_fts')
    .all()
    .map((r) => r.dataset_id);
  const embedIds = db
    .query<{ dataset_id: string }, []>('SELECT dataset_id FROM dataset_embeddings')
    .all()
    .map((r) => r.dataset_id);
  const stateIds = indexState.listDatasetIds();
  const failureIds = indexFailures.list().map((r) => r.dataset_id);

  const purged = new Set<string>();
  for (const id of new Set([...ftsIds, ...embedIds, ...stateIds, ...failureIds])) {
    if (activeIds.has(id)) continue;
    deleteFtsRow(db, id);
    deleteEmbedding(db, id);
    indexState.delete(id);
    indexFailures.clear(id);
    purged.add(id);
  }
  c.purged += purged.size;
}
