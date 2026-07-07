import type { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DanniConfig } from '../../../src/config/schema.ts';
import type { EgovBgClient } from '../../../src/crawler/egov-bg-client.ts';
import { flattenHeader, rowsToCsv } from '../../../src/crawler/egov-sync.ts';
import { runEgovSyncRun } from '../../../src/crawler/run-egov-sync.ts';
import { runCurate } from '../../../src/curate/run-curate.ts';
import { openDb } from '../../../src/store/db.ts';
import { runMigrations } from '../../../src/store/migrate.ts';
import { CrawlCheckpointsRepo } from '../../../src/store/repos/crawl-checkpoints.ts';
import { CuratedArtifactsRepo } from '../../../src/store/repos/curated-artifacts.ts';
import { DatasetsRepo } from '../../../src/store/repos/datasets.ts';
import { OrganizationsRepo } from '../../../src/store/repos/organizations.ts';
import { ResourcesRepo } from '../../../src/store/repos/resources.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const FIX = fileURLToPath(new URL('../../fixtures/egov/', import.meta.url));
const fix = (n: string) => JSON.parse(readFileSync(join(FIX, `${n}.json`), 'utf-8'));
const DATASET_URI = fix('getDatasetDetails').data.uri as string;

function fakeClient(overrides: Partial<Record<string, () => unknown>> = {}): EgovBgClient {
  return {
    listDatasets: async () => overrides.listDatasets?.() ?? fix('listDatasets'),
    getDatasetDetails: async () => overrides.getDatasetDetails?.() ?? fix('getDatasetDetails'),
    listResources: async () => overrides.listResources?.() ?? fix('listResources'),
    getResourceData: async () => overrides.getResourceData?.() ?? fix('getResourceData'),
    listOrganisations: async () => fix('listOrganisations'),
  } as unknown as EgovBgClient;
}

function testConfig(): DanniConfig {
  return {
    schedule: {
      onOverlap: 'skip',
      failureRateThreshold: 0.5,
      enabled: false,
      timezone: 'Europe/Sofia',
      notifier: { kind: 'stderr' },
    },
    scope: {},
  } as unknown as DanniConfig;
}

function freshDb(storeRoot: string): Database {
  const db = openDb({ storeRoot, loadVec: false });
  runMigrations(db, join(ROOT, 'migrations'));
  return db;
}

async function capture(
  storeRoot: string,
  db: Database,
  overrides: Partial<Record<string, () => unknown>> = {},
  scope: DanniConfig['scope'] = { datasetIds: [DATASET_URI] },
) {
  return runEgovSyncRun({
    db,
    config: testConfig(),
    client: fakeClient(overrides),
    storeRoot,
    trigger: 'manual',
    scope,
  });
}

describe('crawler.egov-sync', () => {
  it('rowsToCsv serializes a header + rows with CSV escaping', () => {
    expect(
      rowsToCsv([
        ['a', 'b'],
        ['1', '2'],
      ]),
    ).toBe('a,b\n1,2\n');
    expect(
      rowsToCsv([
        ['x,y', 'a"b'],
        ['p\nq', 5],
      ]),
    ).toBe('"x,y","a""b"\n"p\nq",5\n');
    expect(rowsToCsv([['n', null]])).toBe('n,\n');
  });

  it('captures real-shaped datastore data into the store and DB (explicit URIs)', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const db = freshDb(storeRoot);
    const result = await capture(storeRoot, db);

    expect(result.totals.captured).toBe(3);
    expect(result.totals.failed).toBe(0);

    const ds = new DatasetsRepo(db).get(DATASET_URI);
    expect(ds?.title_bg.length).toBeGreaterThan(0);
    expect(ds?.publisher_id).toBe('egov-org-113');
    expect(JSON.parse(ds?.tags_json ?? '[]')).toContain('ППС');
    // dataset-level validator is written to source_etag_or_hash (FR-002)
    expect(ds?.source_etag_or_hash).toBeTruthy();

    expect(new OrganizationsRepo(db).get('egov-org-113')).not.toBeNull();

    const resources = new ResourcesRepo(db).listByDataset(DATASET_URI);
    expect(resources.length).toBe(3);
    const r0 = resources[0];
    expect(r0?.declared_format).toBe('csv');
    expect(r0?.last_outcome).toBe('success');
    expect(r0?.raw_path).toBeTruthy();
    expect(existsSync(join(storeRoot, 'raw', r0?.raw_path as string))).toBe(true);
    const csv = readFileSync(join(storeRoot, 'raw', r0?.raw_path as string), 'utf-8');
    expect(csv.startsWith('РЕГИОН,')).toBe(true);
    db.close();
  });

  it('enumerates via listDatasets when no datasetIds scope is given (--max bounds the session)', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const db = freshDb(storeRoot);
    const result = await runEgovSyncRun({
      db,
      config: testConfig(),
      client: fakeClient(),
      storeRoot,
      trigger: 'manual',
      scope: {},
      max: 1,
    });
    expect(result.totals.discovered).toBe(1);
    expect(result.totals.captured).toBe(3);
    db.close();
  });

  it('captures an empty datastore resource as a valid empty artifact (not a failure)', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const db = freshDb(storeRoot);
    const result = await capture(storeRoot, db, {
      getResourceData: () => ({ success: true, data: [] }),
    });
    // An empty datastore is a valid empty resource, not a failure (it serializes to `[]`).
    expect(result.totals.captured).toBe(3);
    expect(result.totals.failed).toBe(0);
    const r0 = new ResourcesRepo(db).listByDataset(DATASET_URI)[0];
    expect(r0?.last_outcome).toBe('success');
    expect(r0?.raw_path?.endsWith('.json')).toBe(true);
    expect(readFileSync(join(storeRoot, 'raw', r0?.raw_path as string), 'utf-8').trim()).toBe('[]');
    db.close();
  });

  it('treats a datastore response with no data field as an empty capture (live {success:true})', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const db = freshDb(storeRoot);
    // The live egov API returns `{"success":true}` with no `data` for an empty resource —
    // the fake client mirrors that shape; the sync must normalize it to an empty capture.
    const result = await capture(storeRoot, db, {
      getResourceData: () => ({ success: true }),
    });
    expect(result.totals.captured).toBe(3);
    expect(result.totals.failed).toBe(0);
    const r0 = new ResourcesRepo(db).listByDataset(DATASET_URI)[0];
    expect(r0?.last_outcome).toBe('success');
    db.close();
  });

  it('captures a plain-string datastore as a verbatim .txt artifact (free-text/ASCII table)', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const db = freshDb(storeRoot);
    // Some live resources return `data` as a pre-formatted text table (a plain string),
    // not rows/object — it must be captured as text, not rejected as a schema violation.
    const text = 'Izdadeni dokumenti\n+----+------+\n| No | Vid  |\n';
    const result = await capture(storeRoot, db, {
      getResourceData: () => ({ success: true, data: text }),
    });
    expect(result.totals.captured).toBe(3);
    expect(result.totals.failed).toBe(0);
    const r0 = new ResourcesRepo(db).listByDataset(DATASET_URI)[0];
    expect(r0?.last_outcome).toBe('success');
    expect(r0?.raw_path?.endsWith('.txt')).toBe(true);
    expect(readFileSync(join(storeRoot, 'raw', r0?.raw_path as string), 'utf-8')).toBe(text);
    db.close();
  });

  it('captured CSVs curate into tabular artifacts (end-to-end on real-shaped data)', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const db = freshDb(storeRoot);
    await capture(storeRoot, db);
    const curated = await runCurate({ db, storeRoot, curatorVersion: 'egov-test' });
    expect(curated.curated).toBe(3);
    const artifacts = new CuratedArtifactsRepo(db).byDataset(DATASET_URI);
    expect(artifacts.every((a) => a.kind === 'tabular')).toBe(true);
    db.close();
  });

  it('captures array-of-objects datastore data as JSON (non-tabular shape)', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const db = freshDb(storeRoot);
    const objectData = {
      success: true,
      data: [
        { a: 1, b: 'x' },
        { a: 2, b: 'y' },
      ],
    };
    await capture(storeRoot, db, { getResourceData: () => objectData });
    const r0 = new ResourcesRepo(db).listByDataset(DATASET_URI)[0];
    expect(r0?.declared_format).toBe('json');
    expect(r0?.detected_format).toBe('json');
    const raw = JSON.parse(readFileSync(join(storeRoot, 'raw', r0?.raw_path as string), 'utf-8'));
    expect(raw[0].a).toBe(1);
    await runCurate({ db, storeRoot, curatorVersion: 'v' });
    const art = new CuratedArtifactsRepo(db).byDataset(DATASET_URI)[0];
    expect(art?.kind).toBe('json');
    db.close();
  });

  it('skips a dataset whose details fetch fails', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const db = freshDb(storeRoot);
    const result = await capture(storeRoot, db, {
      getDatasetDetails: () => {
        throw new Error('details boom');
      },
    });
    expect(result.totals.failed).toBe(1);
    expect(new DatasetsRepo(db).get(DATASET_URI)).toBeNull();
    db.close();
  });

  it('persists the dataset but no resources when listResources fails', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const db = freshDb(storeRoot);
    const result = await capture(storeRoot, db, {
      listResources: () => {
        throw new Error('list boom');
      },
    });
    expect(result.totals.captured).toBe(0);
    expect(result.totals.failed).toBe(1);
    expect(new DatasetsRepo(db).get(DATASET_URI)).not.toBeNull();
    db.close();
  });

  it('records a failure (Error) for a throwing getResourceData', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const db = freshDb(storeRoot);
    const result = await capture(storeRoot, db, {
      getResourceData: () => {
        throw new Error('data boom');
      },
    });
    expect(result.totals.captured).toBe(0);
    expect(result.totals.failed).toBe(3);
    const r0 = new ResourcesRepo(db).listByDataset(DATASET_URI)[0];
    expect(r0?.last_outcome).toBe('failure');
    expect(r0?.last_failure_reason).toBe('data boom');
    db.close();
  });

  it('records a string failure reason for a non-Error throw (msg String branch)', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const db = freshDb(storeRoot);
    const result = await capture(storeRoot, db, {
      getResourceData: () => {
        const nonError: unknown = 'plain-string';
        throw nonError;
      },
    });
    expect(result.totals.failed).toBe(3);
    expect(new ResourcesRepo(db).listByDataset(DATASET_URI)[0]?.last_failure_reason).toBe(
      'plain-string',
    );
    db.close();
  });

  it('records a string failure reason for a non-Error details throw', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const db = freshDb(storeRoot);
    const result = await capture(storeRoot, db, {
      getDatasetDetails: () => {
        const nonError: unknown = 'details-string';
        throw nonError;
      },
    });
    expect(result.totals.failed).toBe(1);
    db.close();
  });

  it('records a non-Error listResources throw at the dataset level', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const db = freshDb(storeRoot);
    const result = await capture(storeRoot, db, {
      listResources: () => {
        const nonError: unknown = 'list-string';
        throw nonError;
      },
    });
    expect(result.totals.failed).toBe(1);
    db.close();
  });

  it('stores a real string description (descript string branch)', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const db = freshDb(storeRoot);
    const det = JSON.parse(JSON.stringify(fix('getDatasetDetails')));
    det.data.descript = 'Описание на ресурса';
    await capture(storeRoot, db, { getDatasetDetails: () => det });
    expect(new DatasetsRepo(db).get(DATASET_URI)?.description_bg).toBe('Описание на ресурса');
    db.close();
  });

  it('captures the egov source timestamps (created_at/updated_at → metadata_created/modified)', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const db = freshDb(storeRoot);
    const det = JSON.parse(JSON.stringify(fix('getDatasetDetails')));
    det.data.created_at = '2026-06-03T16:47:30Z';
    det.data.updated_at = '2026-06-05T17:08:29Z';
    await capture(storeRoot, db, { getDatasetDetails: () => det });
    const ds = new DatasetsRepo(db).get(DATASET_URI);
    expect(ds?.metadata_created).toBe('2026-06-03T16:47:30Z');
    expect(ds?.metadata_modified).toBe('2026-06-05T17:08:29Z');
    db.close();
  });

  it('leaves metadata_modified null when the egov package omits updated_at', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const db = freshDb(storeRoot);
    const det = JSON.parse(JSON.stringify(fix('getDatasetDetails')));
    delete det.data.created_at;
    delete det.data.updated_at;
    await capture(storeRoot, db, { getDatasetDetails: () => det });
    const ds = new DatasetsRepo(db).get(DATASET_URI);
    expect(ds?.metadata_created).toBeNull();
    expect(ds?.metadata_modified).toBeNull();
    db.close();
  });

  it('does not re-curate a resource whose latest outcome flipped to failure (stale guard)', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const db = freshDb(storeRoot);
    await capture(storeRoot, db);
    const resources = new ResourcesRepo(db);
    const first = resources.listByDataset(DATASET_URI)[0];
    if (!first) throw new Error('expected a captured resource');
    resources.recordOutcome(first.id, 'failure', 'withdrawn upstream');
    const curated = await runCurate({ db, storeRoot, curatorVersion: 'stale' });
    expect(curated.curated).toBe(2);
    db.close();
  });

  it('paginates organisations to resolve a publisher beyond the first page', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const db = freshDb(storeRoot);
    const page1 = {
      success: true,
      total_records: 200,
      organisations: Array.from({ length: 100 }, (_, i) => ({
        id: i + 1,
        uri: `u${i + 1}`,
        name: `Org ${i + 1}`,
      })),
    };
    const page2 = {
      success: true,
      total_records: 200,
      organisations: [{ id: 113, uri: 'u113', name: 'Целева организация' }],
    };
    let call = 0;
    const client = {
      listDatasets: async () => ({ success: true, datasets: [] }),
      getDatasetDetails: async () => fix('getDatasetDetails'),
      listResources: async () => ({ success: true, resources: [] }),
      getResourceData: async () => fix('getResourceData'),
      listOrganisations: async () => (++call === 1 ? page1 : page2),
    } as unknown as EgovBgClient;
    await runEgovSyncRun({
      db,
      config: testConfig(),
      client,
      storeRoot,
      trigger: 'manual',
      scope: { datasetIds: [DATASET_URI] },
    });
    expect(new OrganizationsRepo(db).get('egov-org-113')?.title_bg).toBe('Целева организация');
    db.close();
  });

  it('captures a structured JSON document (object data, e.g. OCDS) as JSON', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const db = freshDb(storeRoot);
    const doc = { success: true, data: { uri: 'x', version: '1.1', releases: [{ id: 'r1' }] } };
    const result = await capture(storeRoot, db, { getResourceData: () => doc });
    expect(result.totals.captured).toBe(3);
    expect(result.totals.failed).toBe(0);
    const r0 = new ResourcesRepo(db).listByDataset(DATASET_URI)[0];
    expect(r0?.declared_format).toBe('json');
    expect(r0?.last_outcome).toBe('success');
    const raw = JSON.parse(readFileSync(join(storeRoot, 'raw', r0?.raw_path as string), 'utf-8'));
    expect(raw.version).toBe('1.1');
    await runCurate({ db, storeRoot, curatorVersion: 'v' });
    expect(new CuratedArtifactsRepo(db).byDataset(DATASET_URI)[0]?.kind).toBe('json');
    db.close();
  });

  it('flattenHeader keeps a clean single-row header', () => {
    expect(
      flattenHeader([
        ['A', 'B'],
        ['1', '2'],
      ]),
    ).toEqual({ header: ['A', 'B'], dataStart: 1 });
  });

  it('flattenHeader merges a 2-row spreadsheet header (merged cells via forward-fill)', () => {
    const rows = [
      ['№', 'Group', '', 'Tail'],
      ['', 'Sub1', 'Sub2', ''],
      ['1', 'x', 'y', 'z'],
    ];
    const { header, dataStart } = flattenHeader(rows);
    expect(dataStart).toBe(2);
    expect(header).toEqual(['№', 'Group Sub1', 'Group Sub2', 'Tail']);
  });

  it('curates multi-row-header datastore data into meaningful transliterated columns', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const db = freshDb(storeRoot);
    const multi = {
      success: true,
      data: [
        ['№ по ред', 'График на обслужване', '', ''],
        ['', 'Час на тръгване', 'Час на връщане', ''],
        ['1', '08:00', '09:00', 'x'],
      ],
    };
    await capture(storeRoot, db, { getResourceData: () => multi });
    await runCurate({ db, storeRoot, curatorVersion: 'v' });
    const art = new CuratedArtifactsRepo(db).byDataset(DATASET_URI)[0];
    const cols = JSON.parse(art?.schema_json ?? '{}').columns as Array<{
      canonicalName: string;
      sourceName: string;
    }>;
    const names = cols.map((c) => c.canonicalName);
    expect(names).toContain('no_po_red');
    expect(names.some((n) => /grafik_na_obsluzhvane_chas_na_tragvane/.test(n))).toBe(true);
    expect(names.every((n) => n !== 'c_' && n !== 'c_c_')).toBe(true);
    expect(cols.some((c) => c.sourceName.includes('Час на тръгване'))).toBe(true);
    db.close();
  });

  it('flattenHeader does NOT merge an all-text data row (no silent row loss)', () => {
    const rows = [
      ['Област', 'Община', ''],
      ['Благоевград', 'Банско', 'планински'],
      ['Видин', 'Белоградчик', 'равнинен'],
    ];
    const { header, dataStart } = flattenHeader(rows);
    expect(dataStart).toBe(1);
    expect(header).toEqual(['Област', 'Община', '']);
  });

  it('flattenHeader does not over-propagate a group label into a trailing column', () => {
    const rows = [
      ['A', 'G', '', 'B'],
      ['', 'S1', 'S2', ''],
      ['1', 'x', 'y', 'z'],
    ];
    expect(flattenHeader(rows).header).toEqual(['A', 'G S1', 'G S2', 'B']);
  });

  it('flattenHeader normalizes a width mismatch (row1 wider than row0)', () => {
    const rows = [
      ['Group', ''],
      ['S1', 'S2', 'S3'],
      ['1', '2', '3'],
    ];
    expect(flattenHeader(rows)).toEqual({
      header: ['Group S1', 'Group S2', 'Group S3'],
      dataStart: 2,
    });
  });

  it('flattenHeader returns an empty header for empty rows', () => {
    expect(flattenHeader([])).toEqual({ header: [], dataStart: 0 });
  });

  it('preserves every data row when a multi-row header is NOT merged', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const db = freshDb(storeRoot);
    const allText = {
      success: true,
      data: [
        ['Област', 'Община', ''],
        ['Благоевград', 'Банско', 'планински'],
        ['Видин', 'Белоградчик', 'равнинен'],
      ],
    };
    await capture(storeRoot, db, { getResourceData: () => allText });
    await runCurate({ db, storeRoot, curatorVersion: 'v' });
    const art = new CuratedArtifactsRepo(db).byDataset(DATASET_URI)[0];
    expect(JSON.parse(art?.schema_json ?? '{}').rowCount).toBe(2);
    db.close();
  });

  it('a publisher scope enumerates + captures only that publisher’s datasets (spec 048 SC-1)', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const db = freshDb(storeRoot);
    // The listDatasets fixture has 3 datasets (org 113, 191, …); scope to org 113 only.
    const result = await capture(storeRoot, db, {}, { publishers: ['egov-org-113'] });
    expect(result.totals.captured).toBe(3);
    expect(result.totals.outOfScope).toBe(0);
    // Only the org-113 dataset is frozen — the other publishers’ uris never enter the campaign.
    expect(new CrawlCheckpointsRepo(db).frozenIds(result.scopeHash)).toEqual([DATASET_URI]);
    expect(new DatasetsRepo(db).get(DATASET_URI)?.publisher_id).toBe('egov-org-113');
    db.close();
  });

  it('a tag scope captures a matching dataset (tags resolved from details, FR-301)', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const db = freshDb(storeRoot);
    const oneDataset = {
      success: true,
      datasets: [{ id: 1, uri: DATASET_URI, org_id: 113, name: 'x' }],
    };
    // The details fixture carries the 'ППС' tag → in scope.
    const result = await capture(
      storeRoot,
      db,
      { listDatasets: () => oneDataset },
      { tags: ['ППС'] },
    );
    expect(result.totals.captured).toBe(3);
    expect(result.totals.outOfScope).toBe(0);
    db.close();
  });

  it('a tag scope records a non-matching dataset as outOfScope, never captured (FR-301/303)', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const db = freshDb(storeRoot);
    const oneDataset = {
      success: true,
      datasets: [{ id: 1, uri: DATASET_URI, org_id: 113, name: 'x' }],
    };
    const result = await capture(
      storeRoot,
      db,
      { listDatasets: () => oneDataset },
      { tags: ['no-such-tag'] },
    );
    expect(result.totals.captured).toBe(0);
    expect(result.totals.failed).toBe(0);
    expect(result.totals.outOfScope).toBe(1);
    // Out of scope → not persisted as a captured dataset.
    expect(new DatasetsRepo(db).get(DATASET_URI)).toBeNull();
    db.close();
  });

  it('captures an empty object datastore ({}) as a valid empty artifact, symmetric with empty array', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const db = freshDb(storeRoot);
    const result = await capture(storeRoot, db, {
      getResourceData: () => ({ success: true, data: {} }),
    });
    expect(result.totals.captured).toBe(3);
    expect(result.totals.failed).toBe(0);
    const r0 = new ResourcesRepo(db).listByDataset(DATASET_URI)[0];
    expect(r0?.last_outcome).toBe('success');
    expect(readFileSync(join(storeRoot, 'raw', r0?.raw_path as string), 'utf-8').trim()).toBe('{}');
    db.close();
  });
});
