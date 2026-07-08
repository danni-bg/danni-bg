import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFtsRow, deleteFtsRow, upsertFtsRow } from '../../../src/index/fts.ts';
import { runMigrations } from '../../../src/store/migrate.ts';
import { CuratedArtifactsRepo } from '../../../src/store/repos/curated-artifacts.ts';
import { DatasetsRepo } from '../../../src/store/repos/datasets.ts';
import { EntitiesRepo } from '../../../src/store/repos/entities.ts';
import { OrganizationsRepo } from '../../../src/store/repos/organizations.ts';
import { ResourcesRepo } from '../../../src/store/repos/resources.ts';
import { TranslationsRepo } from '../../../src/store/repos/translations.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const MIGRATIONS = join(ROOT, 'migrations');

function setup(): { db: Database } {
  const d = new Database(':memory:');
  d.exec('PRAGMA foreign_keys = ON;');
  runMigrations(d, MIGRATIONS);
  new OrganizationsRepo(d).upsert({
    id: 'p1',
    slug: 'p1',
    titleBg: 'Столична община',
    sourceUrl: 'https://x/p1',
  });
  new DatasetsRepo(d).upsert({
    id: 'd1',
    slug: 'd1',
    titleBg: 'Бюджет 2025',
    descriptionBg: 'Описание',
    publisherId: 'p1',
    tags: ['budget'],
    groups: ['finansi'],
    sourceUrl: 'https://x/d1',
  });
  new ResourcesRepo(d).upsert({ id: 'r1', datasetId: 'd1', sourceUrl: 'https://x/r1.csv' });
  new TranslationsRepo(d).upsert({
    subjectKind: 'dataset_title',
    subjectId: 'd1',
    textBg: 'Бюджет 2025',
    textEn: 'Budget 2025',
    translator: 'local-marianmt:v1',
    confidence: 0.7,
  });
  new TranslationsRepo(d).upsert({
    subjectKind: 'dataset_description',
    subjectId: 'd1',
    textBg: 'Описание',
    textEn: 'Description',
    translator: 'local-marianmt:v1',
    confidence: 0.7,
  });
  const e = new EntitiesRepo(d);
  e.upsert({
    id: 'geo:bg-municipality-sofia',
    kind: 'geographic_unit',
    canonicalLabelBg: 'Столична община',
  });
  e.attach({
    datasetId: 'd1',
    entityId: 'geo:bg-municipality-sofia',
    extractor: 'gaz',
    confidence: 0.9,
  });
  new CuratedArtifactsRepo(d).upsert({
    datasetId: 'd1',
    resourceId: 'r1',
    kind: 'tabular',
    path: 'd1/r1/data.ndjson',
    schemaJson: JSON.stringify({
      kind: 'tabular',
      columns: [{ canonicalName: 'col1', sourceName: 'Бюджет' }],
    }),
    transformRulesJson: '[]',
    curatorVersion: 'v1',
  });
  return { db: d };
}

describe('index.fts', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });
  afterEach(() => {
    s.db.close();
  });

  it('buildFtsRow composes both Cyrillic and Latin signals', () => {
    const row = buildFtsRow(s.db, 'd1');
    expect(row?.title_bg).toBe('Бюджет 2025');
    expect(row?.title_en).toBe('Budget 2025');
    expect(row?.publisher_label).toBe('Столична община');
    expect(row?.tag_labels).toContain('budget');
    expect(row?.entity_labels).toContain('Столична община');
    expect(row?.column_labels).toContain('Бюджет');
  });

  it('returns null for missing dataset', () => {
    expect(buildFtsRow(s.db, 'missing')).toBeNull();
  });

  it('upsertFtsRow + Cyrillic FTS query roundtrip', () => {
    const row = buildFtsRow(s.db, 'd1');
    if (!row) throw new Error('row missing');
    upsertFtsRow(s.db, row);
    const out = s.db
      .query<{ dataset_id: string }, [string]>(
        'SELECT dataset_id FROM datasets_fts WHERE datasets_fts MATCH ? ORDER BY rank',
      )
      .all('"Бюджет"');
    expect(out.map((r) => r.dataset_id)).toContain('d1');
  });

  it('deleteFtsRow removes the row', () => {
    const row = buildFtsRow(s.db, 'd1');
    if (!row) throw new Error('row missing');
    upsertFtsRow(s.db, row);
    deleteFtsRow(s.db, 'd1');
    const cnt = s.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM datasets_fts').get();
    expect(cnt?.n).toBe(0);
  });

  it('readColumnLabels tolerates empty, column-less, malformed, and sourceName-less schemas', () => {
    const res = new ResourcesRepo(s.db);
    const arts = new CuratedArtifactsRepo(s.db);
    const mk = (rid: string, schemaJson: string): void => {
      res.upsert({ id: rid, datasetId: 'd1', sourceUrl: `https://x/${rid}.csv` });
      arts.upsert({
        datasetId: 'd1',
        resourceId: rid,
        kind: 'tabular',
        path: `d1/${rid}/data.ndjson`,
        schemaJson,
        transformRulesJson: '[]',
        curatorVersion: 'v1',
      });
    };
    mk('r-empty', ''); // falsy schema_json → []
    mk('r-nocols', JSON.stringify({ kind: 'tabular' })); // no columns key → []
    mk('r-bad', 'not-json{'); // JSON.parse throws → catch → []
    mk('r-canon', JSON.stringify({ columns: [{ canonicalName: 'КолонаБезИзточник' }] })); // sourceName ?? canonicalName fallback

    const row = buildFtsRow(s.db, 'd1');
    // Original 'Бюджет' column plus the canonicalName-only fallback both surface; the empty/bad/no-column
    // artifacts contribute nothing and never throw.
    expect(row?.column_labels).toContain('Бюджет');
    expect(row?.column_labels).toContain('КолонаБезИзточник');
  });
});
