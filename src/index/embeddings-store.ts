import type { Database } from 'bun:sqlite';
import { nowIso, parseIso, toIso } from '../lib/time.ts';

export interface EmbeddingRow {
  dataset_id: string;
  vector: Float32Array;
}

export interface EmbeddingsMetaRow {
  id: number;
  model_id: string | null;
  dimension: number | null;
  updated_at: string | null;
}

/**
 * Plain-SQLite embedding store: a regular table mirroring what `vec0` would expose,
 * stored as a BLOB. The richer sqlite-vec virtual table is created lazily once a real
 * embedder is wired in (vendor binary). Until then, vector similarity is computed in JS
 * by `query.ts`.
 */
export function ensureEmbeddingsTable(db: Database): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS dataset_embeddings (dataset_id TEXT PRIMARY KEY, vector BLOB NOT NULL, updated_at TEXT NOT NULL)',
  );
}

/**
 * The next strictly-monotonic `updated_at` value: the wall clock, or `prev + 1ms` when the clock has
 * not advanced past a previously-recorded value. Keeping every write monotonic (not just
 * {@link bumpEmbeddingsMeta}) means a model-change `setEmbeddingsMeta` can never move the token
 * BACKWARDS below a prior bump — otherwise a fast re-index's own bump could merely restore the old
 * value and be masked from the vector cache (spec 050 FR-321).
 */
function nextMonotonicUpdatedAt(prev: string | null): string {
  const next = nowIso();
  if (prev !== null && next <= prev) return toIso(parseIso(prev).getTime() + 1);
  return next;
}

export function setEmbeddingsMeta(db: Database, modelId: string, dimension: number): void {
  const next = nextMonotonicUpdatedAt(getEmbeddingsMeta(db).updated_at);
  db.query(
    'UPDATE embeddings_meta SET model_id = ?, dimension = ?, updated_at = ? WHERE id = 1',
  ).run(modelId, dimension, next);
}

/**
 * Advance `embeddings_meta.updated_at` so the in-process vector cache (`vector-cache.ts`) observes an
 * index run's new/purged vectors on its next O(1) stale-check (spec 050 FR-321). Called once at the
 * end of a `danni index` run that actually changed vectors. Strictly monotonic even when two runs
 * land in the same millisecond (a non-advancing clock becomes `prev + 1ms`), so a fast re-index is
 * never masked; the value stays a valid ISO-8601 timestamp.
 */
export function bumpEmbeddingsMeta(db: Database): void {
  const next = nextMonotonicUpdatedAt(getEmbeddingsMeta(db).updated_at);
  db.query('UPDATE embeddings_meta SET updated_at = ? WHERE id = 1').run(next);
}

export function getEmbeddingsMeta(db: Database): EmbeddingsMetaRow {
  const row = db.query<EmbeddingsMetaRow, []>('SELECT * FROM embeddings_meta WHERE id = 1').get();
  if (!row) throw new Error('embeddings_meta missing');
  return row;
}

export function upsertEmbedding(db: Database, datasetId: string, vector: Float32Array): void {
  ensureEmbeddingsTable(db);
  const buf = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
  db.query(
    'INSERT OR REPLACE INTO dataset_embeddings (dataset_id, vector, updated_at) VALUES (?, ?, ?)',
  ).run(datasetId, buf, nowIso());
}

export function deleteEmbedding(db: Database, datasetId: string): void {
  db.query('DELETE FROM dataset_embeddings WHERE dataset_id = ?').run(datasetId);
}

export function listEmbeddings(db: Database): EmbeddingRow[] {
  ensureEmbeddingsTable(db);
  const rows = db
    .query<{ dataset_id: string; vector: Buffer }, []>(
      'SELECT dataset_id, vector FROM dataset_embeddings',
    )
    .all();
  return rows.map((r) => ({
    dataset_id: r.dataset_id,
    vector: new Float32Array(
      r.vector.buffer.slice(r.vector.byteOffset, r.vector.byteOffset + r.vector.byteLength),
    ),
  }));
}
