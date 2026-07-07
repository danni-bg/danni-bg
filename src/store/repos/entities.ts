import type { Database } from 'bun:sqlite';
import { nowIso } from '../../lib/time.ts';

export type EntityKind =
  | 'organization'
  | 'geographic_unit'
  | 'time_period'
  | 'named_subject'
  | 'tag'
  | 'group';

export interface EntityRow {
  id: string;
  kind: EntityKind;
  canonical_label_bg: string;
  canonical_label_en: string | null;
  attributes_json: string;
}

export interface UpsertEntityInput {
  id: string;
  kind: EntityKind;
  canonicalLabelBg: string;
  canonicalLabelEn?: string | null;
  attributes?: Record<string, unknown>;
}

export interface DatasetEntityRow {
  dataset_id: string;
  entity_id: string;
  extractor: string;
  confidence: number;
  evidence_json: string;
  attached_at: string;
}

export interface AttachEntityInput {
  datasetId: string;
  entityId: string;
  extractor: string;
  confidence: number;
  evidence?: Record<string, unknown>;
  attachedAt?: string;
}

export class EntitiesRepo {
  constructor(private readonly db: Database) {}

  // No field-diff to compute, so this is the plain single-statement upsert idiom (spec 052 FR-342):
  // one atomic `INSERT ... ON CONFLICT DO UPDATE`, never a racy read-then-write.
  upsert(input: UpsertEntityInput): EntityRow {
    this.db
      .query(
        `INSERT INTO entities (id, kind, canonical_label_bg, canonical_label_en, attributes_json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind,
           canonical_label_bg = excluded.canonical_label_bg,
           canonical_label_en = excluded.canonical_label_en,
           attributes_json = excluded.attributes_json`,
      )
      .run(
        input.id,
        input.kind,
        input.canonicalLabelBg,
        input.canonicalLabelEn ?? null,
        JSON.stringify(input.attributes ?? {}),
      );
    return this.get(input.id) as EntityRow;
  }

  get(id: string): EntityRow | null {
    return this.db.query<EntityRow, [string]>('SELECT * FROM entities WHERE id = ?').get(id) ?? null;
  }

  // `ON CONFLICT DO UPDATE` rather than `INSERT OR REPLACE` (spec 052 FR-342): the latter is
  // delete+reinsert (fires FK cascade / rowid churn); this in-place update is the safer single
  // atomic statement on the (dataset_id, entity_id, extractor) primary key.
  attach(input: AttachEntityInput): void {
    const at = input.attachedAt ?? nowIso();
    this.db
      .query(
        `INSERT INTO dataset_entities (dataset_id, entity_id, extractor, confidence, evidence_json, attached_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(dataset_id, entity_id, extractor) DO UPDATE SET
           confidence = excluded.confidence,
           evidence_json = excluded.evidence_json,
           attached_at = excluded.attached_at`,
      )
      .run(
        input.datasetId,
        input.entityId,
        input.extractor,
        input.confidence,
        JSON.stringify(input.evidence ?? {}),
        at,
      );
  }

  listAttachments(datasetId: string): DatasetEntityRow[] {
    return this.db
      .query<DatasetEntityRow, [string]>(
        'SELECT * FROM dataset_entities WHERE dataset_id = ? ORDER BY entity_id',
      )
      .all(datasetId);
  }

  datasetsForEntity(entityId: string): string[] {
    return this.db
      .query<{ dataset_id: string }, [string]>(
        'SELECT DISTINCT dataset_id FROM dataset_entities WHERE entity_id = ? ORDER BY dataset_id',
      )
      .all(entityId)
      .map((r) => r.dataset_id);
  }

  entitiesForDataset(datasetId: string): EntityRow[] {
    return this.db
      .query<EntityRow, [string]>(
        'SELECT DISTINCT e.* FROM entities e JOIN dataset_entities de ON de.entity_id = e.id WHERE de.dataset_id = ? ORDER BY e.id',
      )
      .all(datasetId);
  }
}
