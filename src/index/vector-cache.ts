import type { Database } from 'bun:sqlite';
import { listEmbeddings } from './embeddings-store.ts';

/**
 * One resident, deserialized copy of the embedding corpus per store connection (spec 050 FR-320).
 *
 * `search()` used to call `listEmbeddings()` on every query, which SELECTs every row of
 * `dataset_embeddings` and copies each BLOB into a fresh `Float32Array` — ~190 MB of allocation per
 * query at the production ~12k×4096-dim corpus, on the hot path of `GET /api/datasets?query`, every
 * chat `mirrorSearch`, and MCP `mirror_search`. This cache keeps a single deserialized matrix per DB
 * and reuses it across queries; per-query allocation drops to O(candidates).
 *
 * Invalidation (FR-321) is an O(1) stale-check against `embeddings_meta.updated_at`, which every
 * `danni index` run bumps once it has written/purged vectors (see `bumpEmbeddingsMeta`,
 * `src/index/embeddings-store.ts`, called from `run-index.ts`). A cross-process index run is visible
 * to the running explorer/MCP on its next query without a restart.
 *
 * Bun runs JS single-threaded, so concurrent HTTP handlers never observe a half-populated entry: the
 * `listEmbeddings` load is synchronous and the map write is atomic w.r.t. other handlers. The cache
 * is a {@link WeakMap} keyed by the DB handle, so a closed/GC'd connection frees its matrix (memory
 * stays bounded to the live stores).
 */
export interface VectorMatrix {
  /** Dataset ids, index-aligned with {@link vectors}. */
  readonly ids: readonly string[];
  /** One resident f32 vector per dataset, index-aligned with {@link ids}. */
  readonly vectors: readonly Float32Array[];
}

interface CacheEntry {
  version: string;
  matrix: VectorMatrix;
}

const byDb = new WeakMap<Database, CacheEntry>();

/**
 * Monotonic count of full-corpus deserializations across every DB, for the steady-state guard
 * (FR-325 / SC-1): a test snapshots this, runs N searches, and asserts the delta is ≤ 1.
 */
let corpusLoads = 0;

export function corpusLoadCount(): number {
  return corpusLoads;
}

/** O(1) staleness token: the single-row `embeddings_meta.updated_at` (PK lookup, no scan). */
function embeddingsVersion(db: Database): string {
  const row = db
    .query<{ updated_at: string | null }, []>('SELECT updated_at FROM embeddings_meta WHERE id = 1')
    .get();
  return row?.updated_at ?? '';
}

/**
 * The resident embedding matrix for a store, loaded at most once per `embeddings_meta.updated_at`
 * value. A cache hit copies nothing; a miss (first call, or a newer index run) reloads the corpus.
 */
export function getVectorMatrix(db: Database): VectorMatrix {
  const version = embeddingsVersion(db);
  const hit = byDb.get(db);
  if (hit && hit.version === version) return hit.matrix;

  const rows = listEmbeddings(db);
  const matrix: VectorMatrix = {
    ids: rows.map((r) => r.dataset_id),
    vectors: rows.map((r) => r.vector),
  };
  corpusLoads++;
  byDb.set(db, { version, matrix });
  return matrix;
}

/** Drop a connection's cached matrix (e.g. a same-process index run wanting an immediate reload). */
export function invalidateVectorCache(db: Database): void {
  byDb.delete(db);
}
