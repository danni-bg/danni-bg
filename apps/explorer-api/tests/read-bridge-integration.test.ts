// ReadBridge live-store methods (rows / search / entityDatasets / listAllIds) against a seeded
// in-memory store, complementing the pure projection unit tests.

import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalOnnxEmbedder } from '../../../src/index/embedders/local-onnx.ts';
import { runIndex } from '../../../src/index/run-index.ts';
import { openDb } from '../../../src/store/db.ts';
import { runMigrations } from '../../../src/store/migrate.ts';
import { DatasetsRepo } from '../../../src/store/repos/datasets.ts';
import { EntitiesRepo } from '../../../src/store/repos/entities.ts';
import { ResourcesRepo } from '../../../src/store/repos/resources.ts';
import { ReadBridge } from '../src/read-bridge.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

describe('ReadBridge live methods', () => {
  let db: Database;
  let bridge: ReadBridge;

  beforeEach(async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    db = openDb({ storeRoot, loadVec: false });
    runMigrations(db, join(ROOT, 'migrations'));
    new DatasetsRepo(db).upsert({
      id: 'd1',
      slug: 'd1',
      titleBg: 'Въздух',
      tags: [],
      groups: [],
      sourceUrl: 'https://x/d1',
    });
    new ResourcesRepo(db).upsert({
      id: 'r1',
      datasetId: 'd1',
      sourceUrl: 'https://x/d1/r1',
      name: 'rows',
    });
    const ents = new EntitiesRepo(db);
    ents.upsert({ id: 'geo:bg-oblast-ruse', kind: 'geographic_unit', canonicalLabelBg: 'Русе' });
    ents.attach({
      datasetId: 'd1',
      entityId: 'geo:bg-oblast-ruse',
      extractor: 'g',
      confidence: 0.5,
    });
    const embedder = new LocalOnnxEmbedder({ dimension: 8 });
    await runIndex({ db, embedder });
    bridge = new ReadBridge({ db, storeRoot, embedder, freshnessSloSeconds: 86400 });
  });
  afterEach(() => db.close());

  it('listAllIds returns seeded ids', () => {
    expect(bridge.listAllIds()).toEqual(['d1']);
  });

  it('rows returns an (uncurated) resource content shape', () => {
    const out = bridge.rows('d1', 'r1', 10, 0);
    expect(out.datasetId).toBe('d1');
    expect(out.total).toBe(0);
    expect(out.rows).toEqual([]);
  });

  it('rows throws for a missing resource', () => {
    expect(() => bridge.rows('d1', 'nope')).toThrow();
  });

  it('search finds the dataset by keyword', async () => {
    const hits = await bridge.search('Въздух', 5);
    expect(hits.some((h) => h.datasetId === 'd1')).toBe(true);
  });

  it('entityDatasets resolves datasets linked to a geo entity', async () => {
    const hits = await bridge.entityDatasets('geo:bg-oblast-ruse', 10);
    expect(hits.map((h) => h.datasetId)).toEqual(['d1']);
  });
});
