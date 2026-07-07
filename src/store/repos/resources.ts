import type { Database } from 'bun:sqlite';
import { nowIso } from '../../lib/time.ts';
import type { LifecycleState } from './datasets.ts';

/**
 * `declared_format`/`detected_format` sentinel for an egov datastore capture: `store/raw/` holds the
 * verbatim `getResourceData` response envelope (spec 049 FR-310), and this hint routes it to the
 * datastore-JSON curator ahead of the generic JSON curator (FR-312). Defined here — the store layer
 * both sync and curate already depend on — so neither has to import the other (FR-315).
 */
export const EGOV_DATASTORE_FORMAT = 'egov-datastore';

export type ResourceOutcome =
  | 'success'
  | 'failure'
  | 'skipped_unchanged'
  | 'withdrawn'
  | 'out_of_scope';

export interface ResourceRow {
  id: string;
  dataset_id: string;
  position: number;
  name: string | null;
  description_bg: string | null;
  declared_format: string | null;
  detected_content_type: string | null;
  detected_format: string | null;
  source_url: string;
  bytes: number | null;
  sha256: string | null;
  raw_path: string | null;
  etag: string | null;
  last_modified: string | null;
  first_seen_at: string;
  last_synced_at: string;
  last_outcome: ResourceOutcome;
  last_failure_reason: string | null;
  lifecycle_state: LifecycleState;
}

export interface UpsertResourceInput {
  id: string;
  datasetId: string;
  position?: number;
  name?: string | null | undefined;
  descriptionBg?: string | null | undefined;
  declaredFormat?: string | null | undefined;
  sourceUrl: string;
  now?: string;
  lifecycleState?: LifecycleState;
}

export interface UpdateResourceCaptureInput {
  id: string;
  bytes: number;
  sha256: string;
  rawPath: string;
  detectedFormat?: string | null | undefined;
  detectedContentType?: string | null | undefined;
  etag?: string | null | undefined;
  lastModified?: string | null | undefined;
  outcome: ResourceOutcome;
  failureReason?: string | null | undefined;
  now?: string;
}

export class ResourcesRepo {
  constructor(private readonly db: Database) {}

  upsert(input: UpsertResourceInput): ResourceRow {
    const now = input.now ?? nowIso();
    const existing = this.get(input.id);
    if (!existing) {
      this.db
        .query(
          `INSERT INTO resources (id, dataset_id, position, name, description_bg, declared_format, source_url, first_seen_at, last_synced_at, last_outcome, lifecycle_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'success', ?)`,
        )
        .run(
          input.id,
          input.datasetId,
          input.position ?? 0,
          input.name ?? null,
          input.descriptionBg ?? null,
          input.declaredFormat ?? null,
          input.sourceUrl,
          now,
          now,
          input.lifecycleState ?? 'active',
        );
      return this.get(input.id) as ResourceRow;
    }
    this.db
      .query(
        `UPDATE resources SET position = ?, name = ?, description_bg = ?, declared_format = ?, source_url = ?, last_synced_at = ?, lifecycle_state = ? WHERE id = ?`,
      )
      .run(
        input.position ?? existing.position,
        input.name ?? existing.name,
        input.descriptionBg ?? existing.description_bg,
        input.declaredFormat ?? existing.declared_format,
        input.sourceUrl,
        now,
        input.lifecycleState ?? existing.lifecycle_state,
        input.id,
      );
    return this.get(input.id) as ResourceRow;
  }

  recordCapture(input: UpdateResourceCaptureInput): void {
    const now = input.now ?? nowIso();
    this.db
      .query(
        `UPDATE resources SET bytes = ?, sha256 = ?, raw_path = ?, detected_format = COALESCE(?, detected_format), detected_content_type = COALESCE(?, detected_content_type), etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified), last_synced_at = ?, last_outcome = ?, last_failure_reason = ? WHERE id = ?`,
      )
      .run(
        input.bytes,
        input.sha256,
        input.rawPath,
        input.detectedFormat ?? null,
        input.detectedContentType ?? null,
        input.etag ?? null,
        input.lastModified ?? null,
        now,
        input.outcome,
        input.failureReason ?? null,
        input.id,
      );
  }

  recordOutcome(id: string, outcome: ResourceOutcome, failureReason: string | null = null, now: string = nowIso()): void {
    this.db
      .query(
        `UPDATE resources SET last_outcome = ?, last_failure_reason = ?, last_synced_at = ? WHERE id = ?`,
      )
      .run(outcome, failureReason, now, id);
  }

  setLifecycle(id: string, state: LifecycleState, now: string = nowIso()): void {
    this.db
      .query('UPDATE resources SET lifecycle_state = ?, last_synced_at = ? WHERE id = ?')
      .run(state, now, id);
  }

  get(id: string): ResourceRow | null {
    return this.db.query<ResourceRow, [string]>('SELECT * FROM resources WHERE id = ?').get(id) ?? null;
  }

  listByDataset(datasetId: string): ResourceRow[] {
    return this.db
      .query<ResourceRow, [string]>(
        'SELECT * FROM resources WHERE dataset_id = ? ORDER BY position, id',
      )
      .all(datasetId);
  }
}
