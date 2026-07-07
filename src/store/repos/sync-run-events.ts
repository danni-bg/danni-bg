import type { Database } from 'bun:sqlite';
import { nowIso } from '../../lib/time.ts';

export type EventOutcome =
  | 'discovered'
  | 'captured'
  | 'skipped_unchanged'
  | 'failed'
  | 'withdrawn'
  | 'out_of_scope';

export interface SyncRunEventRow {
  run_id: string;
  dataset_id: string;
  resource_id: string;
  event_at: string;
  outcome: EventOutcome;
  bytes: number | null;
  sha256: string | null;
  failure_reason: string | null;
  http_status: number | null;
}

export interface InsertEventInput {
  runId: string;
  datasetId: string;
  resourceId?: string | null | undefined;
  outcome: EventOutcome;
  bytes?: number | null | undefined;
  sha256?: string | null | undefined;
  failureReason?: string | null | undefined;
  httpStatus?: number | null | undefined;
  eventAt?: string;
}

export class SyncRunEventsRepo {
  constructor(private readonly db: Database) {}

  // `ON CONFLICT DO UPDATE` on the (run_id, dataset_id, resource_id) primary key, not
  // `INSERT OR REPLACE` (spec 052 FR-342): a repeated event for the same key updates the row in place
  // (latest outcome wins) as one atomic statement, rather than delete+reinsert.
  insert(input: InsertEventInput): void {
    const eventAt = input.eventAt ?? nowIso();
    this.db
      .query(
        `INSERT INTO sync_run_events (run_id, dataset_id, resource_id, event_at, outcome, bytes, sha256, failure_reason, http_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, dataset_id, resource_id) DO UPDATE SET
           event_at = excluded.event_at,
           outcome = excluded.outcome,
           bytes = excluded.bytes,
           sha256 = excluded.sha256,
           failure_reason = excluded.failure_reason,
           http_status = excluded.http_status`,
      )
      .run(
        input.runId,
        input.datasetId,
        input.resourceId ?? '',
        eventAt,
        input.outcome,
        input.bytes ?? null,
        input.sha256 ?? null,
        input.failureReason ?? null,
        input.httpStatus ?? null,
      );
  }

  listByRun(runId: string): SyncRunEventRow[] {
    return this.db
      .query<SyncRunEventRow, [string]>(
        'SELECT * FROM sync_run_events WHERE run_id = ? ORDER BY event_at, dataset_id, resource_id',
      )
      .all(runId);
  }

  countsByOutcome(runId: string): Record<EventOutcome, number> {
    const rows = this.db
      .query<{ outcome: EventOutcome; n: number }, [string]>(
        'SELECT outcome, COUNT(*) AS n FROM sync_run_events WHERE run_id = ? GROUP BY outcome',
      )
      .all(runId);
    const counts: Record<EventOutcome, number> = {
      discovered: 0,
      captured: 0,
      skipped_unchanged: 0,
      failed: 0,
      withdrawn: 0,
      out_of_scope: 0,
    };
    for (const r of rows) counts[r.outcome] = r.n;
    return counts;
  }
}
