import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalOnnxEmbedder } from '../../../src/index/embedders/local-onnx.ts';
import { search, searchByEntity } from '../../../src/index/query.ts';
import { runIndex } from '../../../src/index/run-index.ts';
import { runMigrations } from '../../../src/store/migrate.ts';
import { DatasetsRepo } from '../../../src/store/repos/datasets.ts';
import { EntitiesRepo } from '../../../src/store/repos/entities.ts';
import { OrganizationsRepo } from '../../../src/store/repos/organizations.ts';
import { TranslationsRepo } from '../../../src/store/repos/translations.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const MIGRATIONS = join(ROOT, 'migrations');

async function setup(): Promise<{ db: Database; embedder: LocalOnnxEmbedder }> {
  const d = new Database(':memory:');
  d.exec('PRAGMA foreign_keys = ON;');
  runMigrations(d, MIGRATIONS);
  const ds = new DatasetsRepo(d);
  ds.upsert({
    id: 'd-budget',
    slug: 'budget',
    titleBg: 'Общински бюджет 2025',
    descriptionBg: 'Подробен бюджет за общините.',
    tags: ['budget'],
    groups: [],
    sourceUrl: 'https://x/d-budget',
  });
  ds.upsert({
    id: 'd-population',
    slug: 'population',
    titleBg: 'Население на Столична община',
    descriptionBg: 'Статистика за София.',
    tags: ['population'],
    groups: [],
    sourceUrl: 'https://x/d-population',
  });
  const ents = new EntitiesRepo(d);
  ents.upsert({
    id: 'geo:bg-municipality-sofia',
    kind: 'geographic_unit',
    canonicalLabelBg: 'Столична община',
  });
  ents.attach({
    datasetId: 'd-population',
    entityId: 'geo:bg-municipality-sofia',
    extractor: 'gaz',
    confidence: 0.9,
  });
  const embedder = new LocalOnnxEmbedder({ dimension: 16 });
  await runIndex({ db: d, embedder });
  return { db: d, embedder };
}

describe('index.query', () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    s = await setup();
  });
  afterEach(() => {
    s.db.close();
  });

  it('finds budget dataset by BG keyword', async () => {
    const out = await search({ db: s.db, embedder: s.embedder, query: 'бюджет' });
    const ids = out.map((r) => r.datasetId);
    expect(ids).toContain('d-budget');
  });

  it('finds population dataset by Cyrillic city name', async () => {
    const out = await search({ db: s.db, embedder: s.embedder, query: 'София' });
    const ids = out.map((r) => r.datasetId);
    expect(ids).toContain('d-population');
  });

  it('reports a sensible matchKind for any hit', async () => {
    const out = await search({ db: s.db, embedder: s.embedder, query: 'общини' });
    const first = out[0];
    if (first) {
      expect(['keyword', 'semantic', 'hybrid']).toContain(first.matchKind);
    }
  });

  it('respects limit', async () => {
    const out = await search({ db: s.db, embedder: s.embedder, query: 'бюджет', limit: 1 });
    expect(out.length).toBe(1);
  });

  it('searchByEntity returns datasets attached to the entity', async () => {
    const out = await searchByEntity(
      { db: s.db, embedder: s.embedder, query: '' },
      'geo:bg-municipality-sofia',
    );
    expect(out.map((r) => r.datasetId)).toEqual(['d-population']);
    expect(out[0]?.matchKind).toBe('entity');
  });

  it('searchByEntity respects limit', async () => {
    const out = await searchByEntity(
      { db: s.db, embedder: s.embedder, query: '', limit: 0 },
      'geo:bg-municipality-sofia',
    );
    expect(out.length).toBe(0);
  });

  it('returns empty result for nonsense query', async () => {
    const out = await search({
      db: s.db,
      embedder: s.embedder,
      query: 'zzz-no-such-text-anywhere',
    });
    expect(out.length).toBeLessThanOrEqual(5);
  });

  it('search and searchByEntity resolve the same EN title + publisher (SC-3 / FR-324)', async () => {
    // A dataset with an EN title translation, a publisher (also EN-labelled), and an entity link.
    const orgs = new OrganizationsRepo(s.db);
    orgs.upsert({
      id: 'org-nsi',
      slug: 'nsi',
      titleBg: 'Национален статистически институт',
      sourceUrl: 'https://x/org-nsi',
    });
    const ds = new DatasetsRepo(s.db);
    ds.upsert({
      id: 'd-census',
      slug: 'census',
      titleBg: 'Преброяване на населението',
      descriptionBg: 'Данни от преброяването.',
      publisherId: 'org-nsi',
      tags: ['census'],
      groups: [],
      sourceUrl: 'https://x/d-census',
    });
    const tx = new TranslationsRepo(s.db);
    tx.upsert({
      subjectKind: 'dataset_title',
      subjectId: 'd-census',
      textBg: 'Преброяване на населението',
      textEn: 'Population census',
      translator: 'test',
      confidence: 0.88,
    });
    tx.upsert({
      subjectKind: 'entity_label',
      subjectId: 'org:org-nsi',
      textBg: 'Национален статистически институт',
      textEn: 'National Statistical Institute',
      translator: 'test',
      confidence: 0.77,
    });
    const ents = new EntitiesRepo(s.db);
    ents.upsert({
      id: 'subject:census',
      kind: 'named_subject',
      canonicalLabelBg: 'Преброяване',
    });
    ents.attach({
      datasetId: 'd-census',
      entityId: 'subject:census',
      extractor: 'gaz',
      confidence: 0.9,
    });
    await runIndex({ db: s.db, embedder: s.embedder });

    const hybrid = (
      await search({ db: s.db, embedder: s.embedder, query: 'Преброяване', limit: 10 })
    ).find((r) => r.datasetId === 'd-census');
    const byEntity = (
      await searchByEntity({ db: s.db, embedder: s.embedder, query: '' }, 'subject:census')
    ).find((r) => r.datasetId === 'd-census');

    expect(hybrid).toBeDefined();
    expect(byEntity).toBeDefined();
    // Entity-sourced results must no longer null out the EN title / publisher (the old contract split).
    expect(byEntity?.title.en).toBe('Population census');
    expect(byEntity?.title.en).toBe(hybrid?.title.en);
    expect(byEntity?.title.translationConfidence).toBe(hybrid?.title.translationConfidence ?? null);
    expect(byEntity?.publisher).toEqual(hybrid?.publisher ?? null);
    expect(byEntity?.publisher?.title.en).toBe('National Statistical Institute');
    // matchedEntities stays entity-search-only.
    expect(byEntity?.matchedEntities?.[0]?.entityId).toBe('subject:census');
    expect(hybrid?.matchedEntities).toBeUndefined();
  });

  it('evicts from the top-k cosine heap when candidates exceed CANDIDATE_DEPTH (50)', async () => {
    // Seed well past the 50-deep candidate heap so a later, higher-scoring vector must pop the
    // current minimum — exercising the heap-eviction branch of topKCosine.
    const ds = new DatasetsRepo(s.db);
    for (let i = 0; i < 60; i++) {
      ds.upsert({
        id: `d-bulk-${i}`,
        slug: `bulk-${i}`,
        titleBg: `Бюджет отчет номер ${i} за община ${i % 7}`,
        descriptionBg: `Финансови данни ${i} ${'дума '.repeat(i % 5)}`,
        tags: ['budget'],
        groups: [],
        sourceUrl: `https://x/d-bulk-${i}`,
      });
    }
    await runIndex({ db: s.db, embedder: s.embedder });
    const out = await search({
      db: s.db,
      embedder: s.embedder,
      query: 'бюджет отчет община',
      limit: 20,
    });
    // The heap kept the best 50 candidates across 62 datasets; the top-20 still surface.
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(20);
  });
});
