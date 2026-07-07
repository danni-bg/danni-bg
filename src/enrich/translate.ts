import type { TranslationSubjectKind, TranslationsRepo } from '../store/repos/translations.ts';
import type { Translator } from './translator.ts';

export interface TranslateSubjectInput {
  subjectKind: TranslationSubjectKind;
  subjectId: string;
  textBg: string;
}

export interface TranslateRunOptions {
  translator: Translator;
  repo: TranslationsRepo;
}

export interface TranslateRunResult {
  /** Subjects translated (translator invoked + row written). */
  count: number;
  /** Subjects skipped because the stored (subject, translator, text_bg) was unchanged. */
  skipped: number;
  /** Subjects with empty/whitespace source text — no translation attempted. */
  empty: number;
}

export async function translateSubjects(
  opts: TranslateRunOptions,
  inputs: TranslateSubjectInput[],
): Promise<TranslateRunResult> {
  let count = 0;
  let skipped = 0;
  let empty = 0;
  for (const input of inputs) {
    if (input.textBg.trim() === '') {
      empty++;
      continue;
    }
    // Compare-and-skip (FR-330): if a row already exists for this
    // (subject kind, subject id, translator) with an identical source, the
    // translation cannot change — don't re-invoke the translator or rewrite it.
    const existing = opts.repo.findExact(input.subjectKind, input.subjectId, opts.translator.id);
    if (existing && existing.text_bg === input.textBg) {
      skipped++;
      continue;
    }
    const result = await opts.translator.translate(input.textBg, 'bg', 'en');
    opts.repo.upsert({
      subjectKind: input.subjectKind,
      subjectId: input.subjectId,
      textBg: input.textBg,
      textEn: result.text,
      translator: opts.translator.id,
      confidence: result.confidence,
    });
    count++;
  }
  return { count, skipped, empty };
}
