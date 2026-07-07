import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TranslationResult, Translator } from '../enrich/translator.ts';
import { LocalMarianMtTranslator } from '../enrich/translators/local-marianmt.ts';
import { runMigrations } from '../store/migrate.ts';
import { DatasetsRepo } from '../store/repos/datasets.ts';
import { runCurate } from './run-curate.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Non-stub translator (noop unset → stage active) that records invocations. */
class CountingTranslator implements Translator {
  calls: string[] = [];
  readonly id = 'hosted-api:test';
  async translate(text: string): Promise<TranslationResult> {
    this.calls.push(text);
    return { text: `EN:${text}`, confidence: 0.9 };
  }
}

function setup() {
  const db = new Database(':memory:');
  runMigrations(db, join(ROOT, 'migrations'));
  const datasets = new DatasetsRepo(db);
  const seed = (id: string, titleBg: string, descriptionBg?: string) =>
    datasets.upsert({
      id,
      slug: id,
      titleBg,
      descriptionBg: descriptionBg ?? null,
      tags: [],
      groups: [],
      sourceUrl: `https://example.test/${id}`,
    });
  const countRows = () =>
    (db.query('SELECT COUNT(*) AS n FROM translations').get() as { n: number }).n;
  return { db, datasets, seed, countRows };
}

const base = { storeRoot: '/tmp', curatorVersion: '0.0.0' };

describe('runCurate translation stage (spec 051)', () => {
  let s: ReturnType<typeof setup>;
  let stderr: string[];
  let stderrSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    s = setup();
    stderr = [];
    stderrSpy = spyOn(process.stderr, 'write').mockImplementation((line: unknown) => {
      stderr.push(String(line));
      return true;
    });
  });
  afterEach(() => {
    stderrSpy.mockRestore();
    s.db.close();
  });

  it('SC-1: two full runs over an unchanged catalog perform zero re-translation', async () => {
    s.seed('ds-1', 'Заглавие едно', 'Описание едно');
    s.seed('ds-2', 'Заглавие две');
    const t = new CountingTranslator();

    const first = await runCurate({ ...base, db: s.db, translator: t });
    expect(first.translationsWritten).toBe(3); // 2 titles + 1 description
    expect(first.translationsSkipped).toBe(0);
    expect(t.calls.length).toBe(3);

    const second = await runCurate({ ...base, db: s.db, translator: t });
    expect(second.translationsWritten).toBe(0);
    expect(second.translationsSkipped).toBe(3);
    expect(t.calls.length).toBe(3); // no new invocations
  });

  it('SC-2: changing one title re-translates exactly that subject', async () => {
    s.seed('ds-1', 'Оригинал', undefined);
    s.seed('ds-2', 'Без промяна');
    const t = new CountingTranslator();
    await runCurate({ ...base, db: s.db, translator: t });
    expect(t.calls.length).toBe(2);

    s.seed('ds-1', 'Променен');
    const res = await runCurate({ ...base, db: s.db, translator: t });
    expect(res.translationsWritten).toBe(1);
    expect(res.translationsSkipped).toBe(1);
    expect(t.calls).toEqual(['Оригинал', 'Без промяна', 'Променен']);
  });

  it('SC-3: a stub translator skips the stage — zero invocations, zero rows, one log line', async () => {
    s.seed('ds-1', 'Заглавие', 'Описание');
    const stub = new LocalMarianMtTranslator();
    expect(stub.noop).toBe(true);
    const translateSpy = spyOn(stub, 'translate');

    const res = await runCurate({ ...base, db: s.db, translator: stub });
    expect(translateSpy).toHaveBeenCalledTimes(0);
    expect(res.translationsWritten).toBe(0);
    expect(s.countRows()).toBe(0);

    const skipLogs = stderr.filter((l) => l.includes('curate.translate-skipped-stub'));
    expect(skipLogs.length).toBe(1);
    expect(skipLogs[0]).toContain(stub.id);
  });

  it('FR-332: a stub with a translateFn override re-enables the stage', async () => {
    s.seed('ds-1', 'Заглавие');
    const wired = new LocalMarianMtTranslator({
      translateFn: async (text) => ({ text: `EN:${text}`, confidence: 0.8 }),
    });
    expect(wired.noop).toBe(false);
    const res = await runCurate({ ...base, db: s.db, translator: wired });
    expect(res.translationsWritten).toBe(1);
    expect(s.countRows()).toBe(1);
    expect(stderr.some((l) => l.includes('curate.translate-skipped-stub'))).toBe(false);
  });

  it('FR-333: curate.completed reports translated/skipped/empty counts', async () => {
    s.seed('ds-1', 'Заглавие');
    const t = new CountingTranslator();
    await runCurate({ ...base, db: s.db, translator: t }); // first run translates the title
    const res = await runCurate({ ...base, db: s.db, translator: t });
    expect(res.translationsWritten).toBe(0);
    expect(res.translationsSkipped).toBe(1);

    const completed = stderr
      .filter((l) => l.includes('curate.completed'))
      .map((l) => JSON.parse(l));
    const last = completed[completed.length - 1];
    expect(last.translationsWritten).toBe(0);
    expect(last.translationsSkipped).toBe(1);
    expect(last.translationsEmpty).toBe(0);
  });
});
