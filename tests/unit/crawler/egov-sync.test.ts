import type { Database } from 'bun:sqlite';
import { describe, expect, it, spyOn } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DanniConfig } from '../../../src/config/schema.ts';
import { BackoffRunner } from '../../../src/crawler/backoff.ts';
import { EgovBgClient } from '../../../src/crawler/egov-bg-client.ts';
import { PortalHttp } from '../../../src/crawler/http.ts';
import { RateLimiter } from '../../../src/crawler/rate-limit.ts';
import { RobotsCache } from '../../../src/crawler/robots.ts';
import { runEgovSyncRun } from '../../../src/crawler/run-egov-sync.ts';
import { runCurate } from '../../../src/curate/run-curate.ts';
import { openDb } from '../../../src/store/db.ts';
import { runMigrations } from '../../../src/store/migrate.ts';
import { CrawlCheckpointsRepo } from '../../../src/store/repos/crawl-checkpoints.ts';
import { CuratedArtifactsRepo } from '../../../src/store/repos/curated-artifacts.ts';
import { DatasetsRepo } from '../../../src/store/repos/datasets.ts';
import { OrganizationsRepo } from '../../../src/store/repos/organizations.ts';
import { EGOV_DATASTORE_FORMAT, ResourcesRepo } from '../../../src/store/repos/resources.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const FIX = fileURLToPath(new URL('../../fixtures/egov/', import.meta.url));
const fix = (n: string) => JSON.parse(readFileSync(join(FIX, `${n}.json`), 'utf-8'));
const fixText = (n: string) => readFileSync(join(FIX, `${n}.json`), 'utf-8');
const DATASET_URI = fix('getDatasetDetails').data.uri as string;

// The fake client's `getResourceData` returns the VERBATIM response body as a STRING (spec 049):
// capture writes those exact bytes to store/raw. Overrides that return an object are serialized;
// an override returning a string is sent as-is.
function fakeClient(overrides: Partial<Record<string, () => unknown>> = {}): EgovBgClient {
  return {
    listDatasets: async () => overrides.listDatasets?.() ?? fix('listDatasets'),
    getDatasetDetails: async () => overrides.getDatasetDetails?.() ?? fix('getDatasetDetails'),
    listResources: async () => overrides.listResources?.() ?? fix('listResources'),
    getResourceData: async () => {
      const v = overrides.getResourceData ? overrides.getResourceData() : fix('getResourceData');
      return typeof v === 'string' ? v : JSON.stringify(v);
    },
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

const rawText = (storeRoot: string, rawPath: string): string =>
  readFileSync(join(storeRoot, 'raw', rawPath), 'utf-8');

describe('crawler.egov-sync', () => {
  it('captures the datastore response BYTE-FOR-BYTE into store/raw (SC-1, verbatim round-trip)', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const db = freshDb(storeRoot);
    // A deliberately non-canonical body (extra spaces + a trailing newline JSON.stringify would
    // drop) proves capture stores the portal's exact bytes, not a re-serialization.
    const verbatim = '{"success":true,  "data":[["РЕГИОН","БРОЙ"],\n["София","5"]]}\n';
    const responder = (method: string): { status?: number; body: string } => {
      if (method === 'getResourceData') return { body: verbatim };
      if (method === 'getDatasetDetails') return { body: fixText('getDatasetDetails') };
      if (method === 'listResources') return { body: fixText('listResources') };
      if (method === 'listOrganisations') return { body: fixText('listOrganisations') };
      return { body: '{"success":true,"datasets":[]}' };
    };
    const fetcher = (async (url: string | URL) => {
      const method = url.toString().split('/').pop() ?? '';
      const { status = 200, body } = responder(method);
      return new Response(body, { status }) as unknown as Response;
    }) as unknown as typeof fetch;
    const http = new PortalHttp({
      userAgent: 'danni-bg/test',
      rateLimiter: new RateLimiter({ requestsPerSecond: 100, concurrency: 4 }),
      backoff: new BackoffRunner({
        initialMs: 5,
        maxMs: 20,
        failureBudget: 1,
        sleep: async () => {},
      }),
      robots: new RobotsCache({ recheckIntervalSeconds: 86400, obey: false }),
      fetcher,
    });
    const client = new EgovBgClient({ baseUrl: 'https://data.egov.bg/api/', http });
    await runEgovSyncRun({
      db,
      config: testConfig(),
      client,
      storeRoot,
      trigger: 'manual',
      scope: { datasetIds: [DATASET_URI] },
    });
    const r0 = new ResourcesRepo(db).listByDataset(DATASET_URI)[0];
    expect(r0?.raw_path?.endsWith('raw.json')).toBe(true);
    // Byte-for-byte: the stored raw equals the exact HTTP response body.
    const stored = readFileSync(join(storeRoot, 'raw', r0?.raw_path as string));
    expect(stored.equals(Buffer.from(verbatim, 'utf-8'))).toBe(true);
    db.close();
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
    // Every egov capture records the datastore hint and writes a verbatim raw.json (FR-310/312).
    expect(r0?.declared_format).toBe(EGOV_DATASTORE_FORMAT);
    expect(r0?.detected_format).toBe(EGOV_DATASTORE_FORMAT);
    expect(r0?.last_outcome).toBe('success');
    expect(r0?.raw_path?.endsWith('raw.json')).toBe(true);
    expect(existsSync(join(storeRoot, 'raw', r0?.raw_path as string))).toBe(true);
    // The raw is the verbatim envelope, not a derived CSV — the tabular header is still in `data`.
    const envelope = JSON.parse(rawText(storeRoot, r0?.raw_path as string));
    expect(envelope.data[0][0]).toBe('РЕГИОН');
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
    // An empty datastore is a valid empty resource, not a failure.
    expect(result.totals.captured).toBe(3);
    expect(result.totals.failed).toBe(0);
    const r0 = new ResourcesRepo(db).listByDataset(DATASET_URI)[0];
    expect(r0?.last_outcome).toBe('success');
    expect(r0?.raw_path?.endsWith('raw.json')).toBe(true);
    // Raw is the verbatim envelope; the curator normalizes the empty data to an empty artifact.
    expect(JSON.parse(rawText(storeRoot, r0?.raw_path as string)).data).toEqual([]);
    await runCurate({ db, storeRoot, curatorVersion: 'v' });
    const art = new CuratedArtifactsRepo(db).byDataset(DATASET_URI)[0];
    expect(existsSync(join(storeRoot, 'curated', art?.path as string))).toBe(true);
    db.close();
  });

  it('treats a datastore response with no data field as an empty capture (live {success:true})', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const db = freshDb(storeRoot);
    // The live egov API returns `{"success":true}` with no `data` for an empty resource — captured
    // verbatim; the curator normalizes the absent field to an empty artifact.
    const result = await capture(storeRoot, db, {
      getResourceData: () => ({ success: true }),
    });
    expect(result.totals.captured).toBe(3);
    expect(result.totals.failed).toBe(0);
    const r0 = new ResourcesRepo(db).listByDataset(DATASET_URI)[0];
    expect(r0?.last_outcome).toBe('success');
    expect(rawText(storeRoot, r0?.raw_path as string)).toBe('{"success":true}');
    db.close();
  });

  it('captures a plain-string datastore verbatim; the curator emits it as text', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const db = freshDb(storeRoot);
    // Some live resources return `data` as a pre-formatted text table (a plain string).
    const text = 'Izdadeni dokumenti\n+----+------+\n| No | Vid  |\n';
    const result = await capture(storeRoot, db, {
      getResourceData: () => ({ success: true, data: text }),
    });
    expect(result.totals.captured).toBe(3);
    expect(result.totals.failed).toBe(0);
    const r0 = new ResourcesRepo(db).listByDataset(DATASET_URI)[0];
    expect(r0?.last_outcome).toBe('success');
    expect(r0?.raw_path?.endsWith('raw.json')).toBe(true);
    expect(JSON.parse(rawText(storeRoot, r0?.raw_path as string)).data).toBe(text);
    await runCurate({ db, storeRoot, curatorVersion: 'v' });
    const art = new CuratedArtifactsRepo(db).byDataset(DATASET_URI)[0];
    expect(art?.kind).toBe('text');
    expect(readFileSync(join(storeRoot, 'curated', art?.path as string), 'utf-8')).toBe(text);
    db.close();
  });

  it('captured datastore rows curate into tabular artifacts (end-to-end on real-shaped data)', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const db = freshDb(storeRoot);
    await capture(storeRoot, db);
    const curated = await runCurate({ db, storeRoot, curatorVersion: 'egov-test' });
    expect(curated.curated).toBe(3);
    const artifacts = new CuratedArtifactsRepo(db).byDataset(DATASET_URI);
    expect(artifacts.every((a) => a.kind === 'tabular')).toBe(true);
    db.close();
  });

  it('captures array-of-objects datastore data; the curator emits JSON (non-tabular shape)', async () => {
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
    expect(r0?.declared_format).toBe(EGOV_DATASTORE_FORMAT);
    const envelope = JSON.parse(rawText(storeRoot, r0?.raw_path as string));
    expect(envelope.data[0].a).toBe(1);
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
      getResourceData: async () => JSON.stringify(fix('getResourceData')),
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

  it('pages organisations to exhaustion — resolves a publisher BEYOND the old 1200 cap (FR-364, SC-3)', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const db = freshDb(storeRoot);
    // 14 full pages of decoy orgs (1400 > the retired MAX_ORG_PAGES=12 × 100 = 1200 cap), then the
    // target org 113 on page 15, then a short page. The old fixed cap stopped at page 12 and left
    // 113 a silent placeholder; paging to exhaustion must still find its real name.
    const seen: number[] = [];
    const client = {
      listDatasets: async () => ({ success: true, datasets: [] }),
      getDatasetDetails: async () => fix('getDatasetDetails'), // org_id 113
      listResources: async () => ({ success: true, resources: [] }),
      getResourceData: async () => JSON.stringify(fix('getResourceData')),
      listOrganisations: async ({ pageNumber }: { pageNumber: number }) => {
        seen.push(pageNumber);
        if (pageNumber <= 14) {
          return {
            success: true,
            organisations: Array.from({ length: 100 }, (_, i) => ({
              id: 100_000 + (pageNumber - 1) * 100 + i,
              uri: `u${pageNumber}-${i}`,
              name: `Decoy ${pageNumber}-${i}`,
            })),
          };
        }
        if (pageNumber === 15) {
          return {
            success: true,
            organisations: [{ id: 113, uri: 'u113', name: 'Късно намерена организация' }],
          };
        }
        return { success: true, organisations: [] };
      },
    } as unknown as EgovBgClient;
    await runEgovSyncRun({
      db,
      config: testConfig(),
      client,
      storeRoot,
      trigger: 'manual',
      scope: { datasetIds: [DATASET_URI] },
    });
    // It paged past the old cap (page 13+) to reach the org on page 15.
    expect(Math.max(...seen)).toBe(15);
    const org = new OrganizationsRepo(db).get('egov-org-113');
    expect(org?.title_bg).toBe('Късно намерена организация');
    expect(org?.slug).not.toMatch(/^unresolved-org-/); // resolved → real slug, not the sentinel
    db.close();
  });

  it('an unresolvable publisher becomes a marked + logged placeholder, not a silent row (FR-365, SC-3)', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const db = freshDb(storeRoot);
    // The default listOrganisations fixture never contains org 113 (the details fixture's org_id):
    // after full paging it stays unresolved, so it must be marked (sentinel slug) AND logged.
    const writes: string[] = [];
    const spy = spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      await capture(storeRoot, db);
    } finally {
      spy.mockRestore();
    }
    const org = new OrganizationsRepo(db).get('egov-org-113');
    expect(org).not.toBeNull();
    // Queryable marker: a deterministic sentinel slug, distinguishable from a real publisher.
    expect(org?.slug).toBe('unresolved-org-113');
    expect(org?.title_bg).toBe('Организация 113');
    // A loud warning carrying the org id + dataset uri was emitted (not a silent placeholder).
    const warned = writes
      .map((w) => {
        try {
          return JSON.parse(w.trim()) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((r): r is Record<string, unknown> => r !== null);
    expect(
      warned.some(
        (r) =>
          r.event === 'egov.org.unresolved' &&
          r.level === 'warn' &&
          r.orgId === 113 &&
          r.datasetUri === DATASET_URI,
      ),
    ).toBe(true);
    db.close();
  });

  it('captures a structured JSON document (object data, e.g. OCDS); the curator emits JSON', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const db = freshDb(storeRoot);
    const doc = { success: true, data: { uri: 'x', version: '1.1', releases: [{ id: 'r1' }] } };
    const result = await capture(storeRoot, db, { getResourceData: () => doc });
    expect(result.totals.captured).toBe(3);
    expect(result.totals.failed).toBe(0);
    const r0 = new ResourcesRepo(db).listByDataset(DATASET_URI)[0];
    expect(r0?.declared_format).toBe(EGOV_DATASTORE_FORMAT);
    expect(r0?.last_outcome).toBe('success');
    expect(JSON.parse(rawText(storeRoot, r0?.raw_path as string)).data.version).toBe('1.1');
    await runCurate({ db, storeRoot, curatorVersion: 'v' });
    expect(new CuratedArtifactsRepo(db).byDataset(DATASET_URI)[0]?.kind).toBe('json');
    db.close();
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

  it('captures an empty object datastore ({}) verbatim; the curator emits an empty JSON artifact', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const db = freshDb(storeRoot);
    const result = await capture(storeRoot, db, {
      getResourceData: () => ({ success: true, data: {} }),
    });
    expect(result.totals.captured).toBe(3);
    expect(result.totals.failed).toBe(0);
    const r0 = new ResourcesRepo(db).listByDataset(DATASET_URI)[0];
    expect(r0?.last_outcome).toBe('success');
    expect(JSON.parse(rawText(storeRoot, r0?.raw_path as string)).data).toEqual({});
    await runCurate({ db, storeRoot, curatorVersion: 'v' });
    const art = new CuratedArtifactsRepo(db).byDataset(DATASET_URI)[0];
    expect(readFileSync(join(storeRoot, 'curated', art?.path as string), 'utf-8').trim()).toBe(
      '{}',
    );
    db.close();
  });

  it('rolls back the resource triple when the checkpoint write faults mid-unit (spec 052 FR-345/SC-1)', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const db = freshDb(storeRoot);
    // Fault-inject a crash between the capture write and the checkpoint write inside the per-resource
    // success transaction. Because the three writes (resource upsert + recordCapture + markResourceSuccess)
    // now run in ONE transaction, the whole unit MUST roll back — no orphan resource/capture row and no
    // checkpoint success mark disagreeing with it.
    const orig = CrawlCheckpointsRepo.prototype.markResourceSuccess;
    CrawlCheckpointsRepo.prototype.markResourceSuccess = () => {
      throw new Error('fault after capture write');
    };
    try {
      await expect(capture(storeRoot, db)).rejects.toThrow('fault after capture write');
    } finally {
      CrawlCheckpointsRepo.prototype.markResourceSuccess = orig;
    }
    // The aborted resource left NO row (rolled back with the checkpoint mark it never reached).
    expect(new ResourcesRepo(db).listByDataset(DATASET_URI).length).toBe(0);

    // A resumed sync (fault cleared) re-captures cleanly — the checkpoint never recorded success, so
    // the resources are re-fetched and persisted; no resources/checkpoint disagreement survives.
    const result = await capture(storeRoot, db);
    expect(result.totals.captured).toBe(3);
    expect(new ResourcesRepo(db).listByDataset(DATASET_URI).length).toBe(3);
    db.close();
  });

  it('a datastore-curation fix re-runs from the verbatim raw alone — no re-crawl (FR-314)', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const db = freshDb(storeRoot);
    let dataCalls = 0;
    const merged = {
      success: true,
      data: [
        ['№', 'График', '', 'Опашка'],
        ['', 'Тръгване', 'Връщане', ''],
        ['1', '08:00', '09:00', 'z'],
      ],
    };
    const overrides = {
      getResourceData: () => {
        dataCalls++;
        return merged;
      },
    };
    await capture(storeRoot, db, overrides);
    const callsAfterCapture = dataCalls;

    // First curate pass (curator "version" v1) over the verbatim raw.
    await runCurate({ db, storeRoot, curatorVersion: 'v1' });
    const cols1 = JSON.parse(
      new CuratedArtifactsRepo(db).byDataset(DATASET_URI)[0]?.schema_json ?? '{}',
    ).columns as Array<{ canonicalName: string }>;
    expect(cols1.some((c) => /grafik_tragvane/.test(c.canonicalName))).toBe(true);

    // Re-run curate (a second "version") over the SAME raw — zero sync involvement, so no new
    // getResourceData fetch — and the merged-header result is reproduced from raw (re-runnability).
    await runCurate({ db, storeRoot, curatorVersion: 'v2' });
    expect(dataCalls).toBe(callsAfterCapture);
    const cols2 = JSON.parse(
      new CuratedArtifactsRepo(db).byDataset(DATASET_URI)[0]?.schema_json ?? '{}',
    ).columns as Array<{ canonicalName: string }>;
    expect(cols2.map((c) => c.canonicalName)).toEqual(cols1.map((c) => c.canonicalName));
    db.close();
  });
});
