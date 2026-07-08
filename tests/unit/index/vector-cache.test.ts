import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalOnnxEmbedder } from '../../../src/index/embedders/local-onnx.ts';
import { search } from '../../../src/index/query.ts';
import { runIndex } from '../../../src/index/run-index.ts';
import {
  corpusLoadCount,
  getVectorMatrix,
  invalidateVectorCache,
} from '../../../src/index/vector-cache.ts';
import { runMigrations } from '../../../src/store/migrate.ts';
import { DatasetsRepo } from '../../../src/store/repos/datasets.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const MIGRATIONS = join(ROOT, 'migrations');

function seedDataset(db: Database, id: string): void {
  new DatasetsRepo(db).upsert({
    id,
    slug: id,
    titleBg: `Общински бюджет ${id}`,
    descriptionBg: `Подробен бюджет за ${id}.`,
    tags: ['budget'],
    groups: [],
    sourceUrl: `https://x/${id}`,
  });
}

async function setup(): Promise<{ db: Database; embedder: LocalOnnxEmbedder }> {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db, MIGRATIONS);
  seedDataset(db, 'd1');
  seedDataset(db, 'd2');
  const embedder = new LocalOnnxEmbedder({ dimension: 16 });
  await runIndex({ db, embedder });
  return { db, embedder };
}

describe('index.vector-cache', () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    s = await setup();
  });
  afterEach(() => {
    s.db.close();
  });

  it('reuses one resident matrix across repeated searches (SC-1 / FR-325)', async () => {
    // Warm the cache once, then assert N further queries deserialize the corpus zero more times.
    await search({ db: s.db, embedder: s.embedder, query: 'бюджет' });
    const before = corpusLoadCount();
    for (let i = 0; i < 10; i++) {
      await search({ db: s.db, embedder: s.embedder, query: 'бюджет' });
    }
    expect(corpusLoadCount() - before).toBe(0);
  });

  it('returns the same matrix instance while embeddings are unchanged (FR-320)', () => {
    const a = getVectorMatrix(s.db);
    const b = getVectorMatrix(s.db);
    expect(b).toBe(a);
    expect(a.ids.length).toBe(2);
  });

  it('invalidates after an index run adds vectors — next search reflects them (FR-321)', async () => {
    const first = getVectorMatrix(s.db);
    expect(first.ids.length).toBe(2);
    const before = corpusLoadCount();

    // A fresh `danni index` run that writes a new vector bumps embeddings_meta.updated_at.
    seedDataset(s.db, 'd3');
    await runIndex({ db: s.db, embedder: s.embedder });

    const reloaded = getVectorMatrix(s.db);
    expect(reloaded).not.toBe(first);
    expect(corpusLoadCount() - before).toBe(1);
    expect([...reloaded.ids].sort()).toEqual(['d1', 'd2', 'd3']);

    const hits = await search({ db: s.db, embedder: s.embedder, query: 'бюджет' });
    expect(hits.map((h) => h.datasetId)).toContain('d3');
  });

  it('invalidateVectorCache forces the next getVectorMatrix to reload (same version)', () => {
    const first = getVectorMatrix(s.db);
    const before = corpusLoadCount();
    // Same embeddings_meta.updated_at, but an explicit drop must reload from scratch.
    invalidateVectorCache(s.db);
    const reloaded = getVectorMatrix(s.db);
    expect(reloaded).not.toBe(first);
    expect(corpusLoadCount() - before).toBe(1);
    expect([...reloaded.ids].sort()).toEqual([...first.ids].sort());
  });

  it('invalidateVectorCache on a never-cached db is a no-op', () => {
    const fresh = new Database(':memory:');
    // No entry has ever been stored for this handle — deleting is harmless.
    expect(() => invalidateVectorCache(fresh)).not.toThrow();
    fresh.close();
  });

  it('invalidates on two back-to-back index runs even within the same millisecond (FR-321)', async () => {
    getVectorMatrix(s.db);
    const before = corpusLoadCount();
    // Re-embed with a different model id: forces a vector rewrite on every dataset. The two runs can
    // land in the same wall-clock ms; the monotonic updated_at bump must still be observed.
    const other = new LocalOnnxEmbedder({ modelId: 'v2', dimension: 16 });
    await runIndex({ db: s.db, embedder: other });
    getVectorMatrix(s.db);
    expect(corpusLoadCount() - before).toBe(1);
  });
});
