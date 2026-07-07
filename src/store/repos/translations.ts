import type { Database } from 'bun:sqlite';
import { nowIso } from '../../lib/time.ts';
import { withTransaction } from '../db.ts';

export type TranslationSubjectKind =
  | 'dataset_title'
  | 'dataset_description'
  | 'resource_description'
  | 'entity_label';

export interface TranslationRow {
  id: number;
  subject_kind: TranslationSubjectKind;
  subject_id: string;
  text_bg: string;
  text_en: string;
  translator: string;
  confidence: number;
  created_at: string;
}

export interface UpsertTranslationInput {
  subjectKind: TranslationSubjectKind;
  subjectId: string;
  textBg: string;
  textEn: string;
  translator: string;
  confidence: number;
  createdAt?: string;
}

export class TranslationsRepo {
  constructor(private readonly db: Database) {}

  // The keep-non-empty rule (below) diffs the stored `text_en` before writing, so per spec 052 FR-343
  // the read (`findExact`) and the write run in ONE transaction — the diff can't be computed against a
  // row a second writer changed between read and write.
  upsert(input: UpsertTranslationInput): TranslationRow {
    return withTransaction(this.db, () => this.upsertInTx(input));
  }

  private upsertInTx(input: UpsertTranslationInput): TranslationRow {
    const at = input.createdAt ?? nowIso();
    const existing = this.findExact(input.subjectKind, input.subjectId, input.translator);
    if (existing) {
      // Don't overwrite a previously-non-empty text_en with an empty result: a
      // translator that returns nothing must not erase a good prior translation.
      const nextEn = input.textEn === '' && existing.text_en !== '' ? existing.text_en : input.textEn;
      this.db
        .query(
          `UPDATE translations SET text_bg = ?, text_en = ?, confidence = ?, created_at = ? WHERE id = ?`,
        )
        .run(input.textBg, nextEn, input.confidence, at, existing.id);
      return this.findById(existing.id) as TranslationRow;
    }
    this.db
      .query(
        `INSERT INTO translations (subject_kind, subject_id, text_bg, text_en, translator, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.subjectKind,
        input.subjectId,
        input.textBg,
        input.textEn,
        input.translator,
        input.confidence,
        at,
      );
    return this.findExact(input.subjectKind, input.subjectId, input.translator) as TranslationRow;
  }

  findExact(
    subjectKind: TranslationSubjectKind,
    subjectId: string,
    translator: string,
  ): TranslationRow | null {
    return (
      this.db
        .query<TranslationRow, [string, string, string]>(
          `SELECT * FROM translations WHERE subject_kind = ? AND subject_id = ? AND translator = ?`,
        )
        .get(subjectKind, subjectId, translator) ?? null
    );
  }

  findById(id: number): TranslationRow | null {
    return (
      this.db.query<TranslationRow, [number]>('SELECT * FROM translations WHERE id = ?').get(id) ??
      null
    );
  }

  forSubject(
    subjectKind: TranslationSubjectKind,
    subjectId: string,
  ): TranslationRow[] {
    return this.db
      .query<TranslationRow, [string, string]>(
        'SELECT * FROM translations WHERE subject_kind = ? AND subject_id = ? ORDER BY translator',
      )
      .all(subjectKind, subjectId);
  }
}
