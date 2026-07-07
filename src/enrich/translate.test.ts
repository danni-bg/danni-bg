import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../store/migrate.ts';
import { TranslationsRepo } from '../store/repos/translations.ts';
import { type TranslateSubjectInput, translateSubjects } from './translate.ts';
import type { TranslationResult, Translator } from './translator.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** A translator that records every invocation so we can assert compare-and-skip. */
class CountingTranslator implements Translator {
  calls: string[] = [];
  constructor(readonly id = 'hosted-api:test') {}
  async translate(text: string): Promise<TranslationResult> {
    this.calls.push(text);
    return { text: `EN:${text}`, confidence: 0.9 };
  }
}

function setup() {
  const db = new Database(':memory:');
  runMigrations(db, join(ROOT, 'migrations'));
  return { db, repo: new TranslationsRepo(db) };
}

const subject = (textBg: string, id = 'ds-1'): TranslateSubjectInput => ({
  subjectKind: 'dataset_title',
  subjectId: id,
  textBg,
});

describe('translateSubjects (spec 051)', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  it('FR-330: skips a subject whose stored (subject, translator, text_bg) is unchanged', async () => {
    const t = new CountingTranslator();
    const first = await translateSubjects({ translator: t, repo: s.repo }, [subject('Заглавие')]);
    expect(first).toEqual({ count: 1, skipped: 0, empty: 0 });
    expect(t.calls.length).toBe(1);

    // SC-1: a second run over the unchanged subject invokes the translator ZERO times.
    const second = await translateSubjects({ translator: t, repo: s.repo }, [subject('Заглавие')]);
    expect(second).toEqual({ count: 0, skipped: 1, empty: 0 });
    expect(t.calls.length).toBe(1);
  });

  it('SC-2: a changed text_bg re-translates exactly the changed subject', async () => {
    const t = new CountingTranslator();
    await translateSubjects({ translator: t, repo: s.repo }, [
      subject('А', 'ds-1'),
      subject('Б', 'ds-2'),
    ]);
    expect(t.calls.length).toBe(2);

    // Only ds-1's source changes on the second run.
    const res = await translateSubjects({ translator: t, repo: s.repo }, [
      subject('А-ново', 'ds-1'),
      subject('Б', 'ds-2'),
    ]);
    expect(res).toEqual({ count: 1, skipped: 1, empty: 0 });
    expect(t.calls).toEqual(['А', 'Б', 'А-ново']);
  });

  it('FR-330: a different translator id re-translates the same subject', async () => {
    const a = new CountingTranslator('hosted-api:v1');
    const b = new CountingTranslator('hosted-api:v2');
    await translateSubjects({ translator: a, repo: s.repo }, [subject('Текст')]);
    const res = await translateSubjects({ translator: b, repo: s.repo }, [subject('Текст')]);
    expect(res.count).toBe(1);
    expect(b.calls.length).toBe(1);
    // Rows are keyed by translator, so both provenance rows survive.
    expect(s.repo.forSubject('dataset_title', 'ds-1').length).toBe(2);
  });

  it('FR-333: empty/whitespace source is counted, never translated', async () => {
    const t = new CountingTranslator();
    const res = await translateSubjects({ translator: t, repo: s.repo }, [
      subject('   '),
      subject('', 'ds-2'),
      subject('Реален', 'ds-3'),
    ]);
    expect(res).toEqual({ count: 1, skipped: 0, empty: 2 });
    expect(t.calls).toEqual(['Реален']);
  });

  it('SC-4: no reference to `force` remains in translate.ts or translations.ts', () => {
    for (const rel of ['src/enrich/translate.ts', 'src/store/repos/translations.ts']) {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      expect(src.toLowerCase()).not.toMatch(/\bforce\b/);
    }
  });
});
