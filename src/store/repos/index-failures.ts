import type { Database } from 'bun:sqlite';
import { nowIso } from '../../lib/time.ts';

/**
 * One row of the `index_failures` snapshot: the current per-dataset reason a vector could not
 * be produced (002-batch-embedding, FR-008). Keyed by `dataset_id` so it is a current snapshot
 * (upsert), never an append-only log; the row is cleared once the dataset embeds successfully.
 */
export interface IndexFailureRow {
  dataset_id: string;
  reason: string;
  updated_at: string;
}

/**
 * Access to `index_failures`. Mirrors the other `src/store/repos/*` classes: constructed with a
 * `Database`, reuses `nowIso()`, and exposes the record/clear/list lifecycle the run-index loop
 * drives (record on a per-text failure or empty text; clear on a successful embed). Kept strictly
 * separate from 003's `index_state` (data-model §1, cross-feature note).
 */
export class IndexFailuresRepo {
  constructor(private readonly db: Database) {}

  /** Upsert the current not-embedded reason for a dataset (re-failure overwrites, bumps updated_at).
   *  `ON CONFLICT DO UPDATE`, not `INSERT OR REPLACE` (spec 052 FR-342): one atomic in-place update. */
  record(datasetId: string, reason: string, now: string = nowIso()): void {
    this.db
      .query(
        `INSERT INTO index_failures (dataset_id, reason, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(dataset_id) DO UPDATE SET reason = excluded.reason, updated_at = excluded.updated_at`,
      )
      .run(datasetId, reason, now);
  }

  /** Delete a dataset's failure row (no-op when absent); called the moment its vector persists. */
  clear(datasetId: string): void {
    this.db.query('DELETE FROM index_failures WHERE dataset_id = ?').run(datasetId);
  }

  /** Current snapshot of all not-embedded datasets, ordered by `dataset_id` (for inspection). */
  list(): IndexFailureRow[] {
    return this.db
      .query<IndexFailureRow, []>('SELECT * FROM index_failures ORDER BY dataset_id')
      .all();
  }
}
