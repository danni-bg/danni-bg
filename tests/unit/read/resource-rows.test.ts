import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readResourceRows } from '../../../src/read/resource-rows.ts';
import { runMigrations } from '../../../src/store/migrate.ts';
import type { CuratedKind } from '../../../src/store/repos/curated-artifacts.ts';
import { CuratedArtifactsRepo } from '../../../src/store/repos/curated-artifacts.ts';
import { DatasetsRepo } from '../../../src/store/repos/datasets.ts';
import { ResourcesRepo } from '../../../src/store/repos/resources.ts';

const MIGRATIONS = fileURLToPath(new URL('../../../migrations', import.meta.url));

function seedDatasetResource(db: Database): void {
  new DatasetsRepo(db).upsert({
    id: 'd1',
    slug: 'd1',
    titleBg: 'T',
    tags: [],
    groups: [],
    sourceUrl: 'https://x/d1',
  });
  new ResourcesRepo(db).upsert({
    id: 'r1',
    datasetId: 'd1',
    sourceUrl: 'https://x/r1',
    declaredFormat: 'csv',
  });
}

function seedCurated(
  db: Database,
  storeRoot: string,
  kind: CuratedKind,
  fileName: string,
  content: string,
): void {
  seedDatasetResource(db);
  const rel = join('d1', 'r1', fileName);
  new CuratedArtifactsRepo(db).upsert({
    datasetId: 'd1',
    resourceId: 'r1',
    kind,
    path: rel,
    schemaJson: '{}',
    transformRulesJson: '[]',
    curatorVersion: 'v1',
  });
  mkdirSync(join(storeRoot, 'curated', 'd1', 'r1'), { recursive: true });
  writeFileSync(join(storeRoot, 'curated', rel), content);
}

describe('read.resource-rows readResourceRows', () => {
  let db: Database;
  let storeRoot: string;
  beforeEach(() => {
    storeRoot = globalThis.__TEST_TMP_DIR__;
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    runMigrations(db, MIGRATIONS);
  });
  afterEach(() => db.close());

  it('reads tabular NDJSON rows with pagination, total and truncated', () => {
    const ndjson = `${[{ a: 1 }, { a: 2 }, { a: 3 }].map((o) => JSON.stringify(o)).join('\n')}\n`;
    seedCurated(db, storeRoot, 'tabular', 'data.ndjson', ndjson);
    const out = readResourceRows(db, storeRoot, 'd1', 'r1', { limit: 2, offset: 0 });
    expect(out.kind).toBe('tabular');
    expect(out.total).toBe(3);
    expect(out.rows).toEqual([{ a: 1 }, { a: 2 }]);
    expect(out.truncated).toBe(true);
    const page2 = readResourceRows(db, storeRoot, 'd1', 'r1', { limit: 2, offset: 2 });
    expect(page2.rows).toEqual([{ a: 3 }]);
    expect(page2.truncated).toBe(false);
  });

  it('returns a single JSON document as `document`', () => {
    seedCurated(db, storeRoot, 'json', 'data.json', JSON.stringify({ ocds: 'x', releases: [1] }));
    const out = readResourceRows(db, storeRoot, 'd1', 'r1');
    expect(out.document).toEqual({ ocds: 'x', releases: [1] });
    expect(out.total).toBe(1);
    expect(out.rows).toEqual([]);
  });

  it('returns a JSON array as paginated rows', () => {
    seedCurated(db, storeRoot, 'json', 'data.json', JSON.stringify([{ x: 1 }, { x: 2 }]));
    const out = readResourceRows(db, storeRoot, 'd1', 'r1', { limit: 1 });
    expect(out.rows).toEqual([{ x: 1 }]);
    expect(out.total).toBe(2);
    expect(out.truncated).toBe(true);
  });

  it('applies sort/filter to a JSON array via the grid path', () => {
    seedCurated(db, storeRoot, 'json', 'data.json', JSON.stringify([{ x: 3 }, { x: 1 }, { x: 2 }]));
    const out = readResourceRows(db, storeRoot, 'd1', 'r1', {
      limit: 2,
      offset: 0,
      grid: { sort: { col: 'x', dir: 'asc' }, filters: {} },
    });
    expect(out.rows).toEqual([{ x: 1 }, { x: 2 }]);
    expect(out.total).toBe(3);
    expect(out.truncated).toBe(true);
    expect(out.gridTruncated).toBe(false);
  });

  it('returns text kinds verbatim', () => {
    seedCurated(db, storeRoot, 'text', 'data.txt', 'hello\nworld\n');
    const out = readResourceRows(db, storeRoot, 'd1', 'r1');
    expect(out.text).toBe('hello\nworld\n');
    expect(out.rows).toEqual([]);
  });

  it('throws when the resource is absent or belongs to another dataset', () => {
    seedDatasetResource(db);
    expect(() => readResourceRows(db, storeRoot, 'd1', 'nope')).toThrow(/not found/);
    expect(() => readResourceRows(db, storeRoot, 'other-ds', 'r1')).toThrow(/not found/);
  });

  it('returns empty rows with kind=null for an uncurated resource', () => {
    seedDatasetResource(db); // resource exists but no curated artifact
    const out = readResourceRows(db, storeRoot, 'd1', 'r1');
    expect(out.kind).toBeNull();
    expect(out.rows).toEqual([]);
    expect(out.total).toBe(0);
  });

  it('handles geojson like json — a single object as `document`', () => {
    seedCurated(
      db,
      storeRoot,
      'geojson',
      'data.json',
      JSON.stringify({ type: 'FeatureCollection', features: [1, 2] }),
    );
    const out = readResourceRows(db, storeRoot, 'd1', 'r1');
    expect((out.document as { type: string }).type).toBe('FeatureCollection');
    expect(out.total).toBe(1);
    expect(out.rows).toEqual([]);
  });

  it('paginates a geojson array', () => {
    seedCurated(
      db,
      storeRoot,
      'geojson',
      'data.json',
      JSON.stringify([{ f: 1 }, { f: 2 }, { f: 3 }]),
    );
    const out = readResourceRows(db, storeRoot, 'd1', 'r1', { limit: 2 });
    expect(out.rows).toEqual([{ f: 1 }, { f: 2 }]);
    expect(out.total).toBe(3);
    expect(out.truncated).toBe(true);
  });

  it('throws a descriptive error on a malformed curated JSON file', () => {
    seedCurated(db, storeRoot, 'json', 'data.json', '{not valid json');
    expect(() => readResourceRows(db, storeRoot, 'd1', 'r1')).toThrow(
      /failed to parse curated artifact/,
    );
  });
});
