import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCurate } from '../../../src/curate/run-curate.ts';
import { LocalMarianMtTranslator } from '../../../src/enrich/translators/local-marianmt.ts';
import { ensureDir } from '../../../src/lib/fs.ts';
import { runMigrations } from '../../../src/store/migrate.ts';
import { CuratedArtifactsRepo } from '../../../src/store/repos/curated-artifacts.ts';
import { DatasetsRepo } from '../../../src/store/repos/datasets.ts';
import { OrganizationsRepo } from '../../../src/store/repos/organizations.ts';
import { ResourcesRepo } from '../../../src/store/repos/resources.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

function setup(): { db: Database; storeRoot: string } {
  const storeRoot = globalThis.__TEST_TMP_DIR__;
  const d = new Database(`${storeRoot}/danni.sqlite`);
  d.exec('PRAGMA foreign_keys = ON;');
  runMigrations(d, join(ROOT, 'migrations'));
  new OrganizationsRepo(d).upsert({
    id: 'p1',
    slug: 'p1',
    titleBg: 'Столична община',
    sourceUrl: 'https://x/p1',
  });
  new DatasetsRepo(d).upsert({
    id: 'd1',
    slug: 'd1',
    titleBg: 'Бюджет',
    descriptionBg: 'Описание',
    publisherId: 'p1',
    tags: [],
    groups: [],
    sourceUrl: 'https://x/d1',
  });
  return { db: d, storeRoot };
}

describe('curate.run-curate', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });
  afterEach(() => {
    s.db.close();
  });

  it('skips resources without a raw_path or missing file', async () => {
    const r = new ResourcesRepo(s.db);
    r.upsert({
      id: 'r-no-raw',
      datasetId: 'd1',
      sourceUrl: 'https://x/r-no-raw',
    });
    // captured (has a raw_path + success outcome) but the raw file is absent on disk
    r.upsert({ id: 'r-gone', datasetId: 'd1', sourceUrl: 'https://x/r-gone.json' });
    r.recordCapture({
      id: 'r-gone',
      bytes: 1,
      sha256: 'b'.repeat(64),
      rawPath: 'd1/r-gone/raw.json',
      outcome: 'success',
    });
    const out = await runCurate({
      db: s.db,
      storeRoot: s.storeRoot,
      curatorVersion: 'v1',
    });
    expect(out.curated).toBe(0);
    expect(out.entitiesAttached).toBeGreaterThan(0); // org/groups/tags etc.
  });

  it('records uncurated row when curator throws', async () => {
    const r = new ResourcesRepo(s.db);
    r.upsert({ id: 'r1', datasetId: 'd1', sourceUrl: 'https://x/r1.json', declaredFormat: 'json' });
    r.recordCapture({
      id: 'r1',
      bytes: 1,
      sha256: 'a'.repeat(64),
      rawPath: 'd1/r1/raw.json',
      outcome: 'success',
    });
    ensureDir(join(s.storeRoot, 'raw', 'd1', 'r1'));
    writeFileSync(join(s.storeRoot, 'raw', 'd1', 'r1', 'raw.json'), 'not valid json');
    const out = await runCurate({
      db: s.db,
      storeRoot: s.storeRoot,
      curatorVersion: 'v1',
    });
    expect(out.uncurated).toBeGreaterThanOrEqual(1);
    const rows = new CuratedArtifactsRepo(s.db).byDataset('d1');
    expect(rows.some((row) => row.kind === 'uncurated')).toBe(true);
  });

  it('honors --datasets filter', async () => {
    new DatasetsRepo(s.db).upsert({
      id: 'd2',
      slug: 'd2',
      titleBg: 'Other',
      tags: [],
      groups: [],
      sourceUrl: 'https://x/d2',
    });
    const out = await runCurate({
      db: s.db,
      storeRoot: s.storeRoot,
      curatorVersion: 'v1',
      datasetIds: ['d2'],
    });
    expect(out.entitiesAttached).toBe(0); // d2 has no org/groups/tags
  });

  it('honors --since filter', async () => {
    const out = await runCurate({
      db: s.db,
      storeRoot: s.storeRoot,
      curatorVersion: 'v1',
      since: '2099-01-01T00:00:00Z',
    });
    expect(out.curated).toBe(0);
    expect(out.entitiesAttached).toBe(0);
  });

  it('--entities-only re-extracts entities without parsing resources or translating', async () => {
    // A captured resource that a full run WOULD parse — entities-only must not touch it.
    const r = new ResourcesRepo(s.db);
    r.upsert({ id: 'r1', datasetId: 'd1', sourceUrl: 'https://x/r1.json', declaredFormat: 'json' });
    r.recordCapture({
      id: 'r1',
      bytes: 1,
      sha256: 'a'.repeat(64),
      rawPath: 'd1/r1/raw.json',
      outcome: 'success',
    });
    ensureDir(join(s.storeRoot, 'raw', 'd1', 'r1'));
    writeFileSync(join(s.storeRoot, 'raw', 'd1', 'r1', 'raw.json'), '{"a":1}');

    // Translator supplied but must be ignored in entities-only mode.
    const translator = new LocalMarianMtTranslator({
      translateFn: async (text) => ({ text: `EN(${text})`, confidence: 0.7 }),
    });
    const out = await runCurate({
      db: s.db,
      storeRoot: s.storeRoot,
      curatorVersion: 'v1',
      entitiesOnly: true,
      translator,
    });

    // No parsing → no artifacts of either kind; no translations.
    expect(out.curated).toBe(0);
    expect(out.uncurated).toBe(0);
    expect(out.translationsWritten).toBe(0);
    expect(new CuratedArtifactsRepo(s.db).byDataset('d1').length).toBe(0);

    // Entities ARE attached, including the publisher-derived place
    // ("Столична община" publisher → geo:bg-municipality-stolichna).
    expect(out.entitiesAttached).toBeGreaterThan(0);
    const geo = s.db
      .query<{ entity_id: string }, []>(
        "SELECT entity_id FROM dataset_entities WHERE dataset_id = 'd1' AND substr(entity_id,1,4) = 'geo:'",
      )
      .all();
    expect(geo.some((g) => g.entity_id === 'geo:bg-municipality-stolichna')).toBe(true);
  });

  it('writes translations when translator is supplied', async () => {
    const translator = new LocalMarianMtTranslator({
      translateFn: async (text) => ({ text: `EN(${text})`, confidence: 0.7 }),
    });
    const out = await runCurate({
      db: s.db,
      storeRoot: s.storeRoot,
      curatorVersion: 'v1',
      translator,
    });
    expect(out.translationsWritten).toBeGreaterThan(0);
  });
});
