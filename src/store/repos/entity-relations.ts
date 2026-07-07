import type { Database } from 'bun:sqlite';
import type { EntityPredicate } from '../../enrich/relations/vocabulary.ts';
import { nowIso } from '../../lib/time.ts';

export interface EntityRelationRow {
  subject_id: string;
  predicate: string;
  object_id: string;
  confidence: number;
  evidence_json: string;
  created_at: string;
}

export interface UpsertRelationInput {
  subjectId: string;
  predicate: EntityPredicate;
  objectId: string;
  confidence: number;
  evidence?: Record<string, unknown>;
  createdAt?: string;
}

/** Read/write access to the entity<->entity relation graph (`entity_relations`). */
export class EntityRelationsRepo {
  constructor(private readonly db: Database) {}

  /** Idempotent: a triple (subject, predicate, object) is unique; re-asserting refreshes it. Uses
   *  `ON CONFLICT DO UPDATE`, not `INSERT OR REPLACE` (spec 052 FR-342): a single atomic in-place
   *  update instead of delete+reinsert. */
  upsert(input: UpsertRelationInput): void {
    this.db
      .query(
        `INSERT INTO entity_relations
           (subject_id, predicate, object_id, confidence, evidence_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(subject_id, predicate, object_id) DO UPDATE SET
           confidence = excluded.confidence,
           evidence_json = excluded.evidence_json,
           created_at = excluded.created_at`,
      )
      .run(
        input.subjectId,
        input.predicate,
        input.objectId,
        input.confidence,
        JSON.stringify(input.evidence ?? {}),
        input.createdAt ?? nowIso(),
      );
  }

  /** Outgoing edges from `subjectId` (optionally filtered to one predicate). */
  bySubject(subjectId: string, predicate?: EntityPredicate): EntityRelationRow[] {
    if (predicate) {
      return this.db
        .query<EntityRelationRow, [string, string]>(
          'SELECT * FROM entity_relations WHERE subject_id = ? AND predicate = ? ORDER BY object_id',
        )
        .all(subjectId, predicate);
    }
    return this.db
      .query<EntityRelationRow, [string]>(
        'SELECT * FROM entity_relations WHERE subject_id = ? ORDER BY predicate, object_id',
      )
      .all(subjectId);
  }

  /** Incoming edges into `objectId` (e.g. an oblast's child municipalities via part_of). */
  byObject(objectId: string, predicate?: EntityPredicate): EntityRelationRow[] {
    if (predicate) {
      return this.db
        .query<EntityRelationRow, [string, string]>(
          'SELECT * FROM entity_relations WHERE object_id = ? AND predicate = ? ORDER BY subject_id',
        )
        .all(objectId, predicate);
    }
    return this.db
      .query<EntityRelationRow, [string]>(
        'SELECT * FROM entity_relations WHERE object_id = ? ORDER BY predicate, subject_id',
      )
      .all(objectId);
  }

  /** All edges with a given predicate (e.g. the whole `part_of` hierarchy). */
  byPredicate(predicate: EntityPredicate): EntityRelationRow[] {
    return this.db
      .query<EntityRelationRow, [string]>(
        'SELECT * FROM entity_relations WHERE predicate = ? ORDER BY subject_id, object_id',
      )
      .all(predicate);
  }

  count(): number {
    return this.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM entity_relations').get()?.n ?? 0;
  }
}
