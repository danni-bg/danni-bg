import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeEmbeddingText } from '../../../src/index/vec.ts';
import { runMigrations } from '../../../src/store/migrate.ts';
import { DatasetsRepo } from '../../../src/store/repos/datasets.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const MIGRATIONS = join(ROOT, 'migrations');

function setup(): { db: Database } {
  const d = new Database(':memory:');
  d.exec('PRAGMA foreign_keys = ON;');
  runMigrations(d, MIGRATIONS);
  new DatasetsRepo(d).upsert({
    id: 'd1',
    slug: 'd1',
    titleBg: 'Бюджет',
    descriptionBg: 'Описание',
    tags: [],
    groups: [],
    sourceUrl: 'https://x/d1',
  });
  return { db: d };
}

// `upsertEmbeddingFor` was removed as a dead export (spec 056 FR-391; the batch-embed path in
// run-index.ts is the sole writer). `composeEmbeddingText` — the embedding-input composer it wrapped
// and which run-index.ts still calls — stays and is exercised here.
describe('index.vec.composeEmbeddingText', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });
  afterEach(() => {
    s.db.close();
  });

  it('returns empty for a missing dataset', () => {
    expect(composeEmbeddingText(s.db, 'missing')).toBe('');
  });

  it('composes the bg title + description for a known dataset', () => {
    const text = composeEmbeddingText(s.db, 'd1');
    expect(text).toContain('Бюджет');
    expect(text).toContain('Описание');
  });
});
