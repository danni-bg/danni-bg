import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { DatastoreJsonCurator } from '../../src/curate/datastore-json.ts';
import { GeoJsonCurator } from '../../src/curate/geojson.ts';
import { JsonCurator } from '../../src/curate/json.ts';
import { TextCurator } from '../../src/curate/text.ts';
import { XmlCurator } from '../../src/curate/xml.ts';
import { EGOV_DATASTORE_FORMAT, type ResourceRow } from '../../src/store/repos/resources.ts';

const FIX = fileURLToPath(new URL('../fixtures/resources/', import.meta.url));
const EGOV_FIX = fileURLToPath(new URL('../fixtures/egov/', import.meta.url));

const TransformRuleSchema = z.object({
  rule: z.string(),
  appliedTo: z.union([z.string(), z.array(z.string())]),
  params: z.record(z.string(), z.unknown()).optional(),
  ruleVersion: z.string().nullable().optional(),
});

/** Contract shape for `JsonShapeSchema` in src/curate/curator.ts (json + geojson families). */
const JsonShapeContract = z
  .object({
    kind: z.enum(['json', 'geojson']),
    encoding: z.literal('utf-8'),
    rootShape: z.enum(['array', 'object', 'feature_collection', 'feature']),
    transformRules: z.array(TransformRuleSchema).optional(),
  })
  .strict();

/** Contract shape for `XmlSchema` in src/curate/curator.ts. */
const XmlContract = z
  .object({
    kind: z.literal('xml'),
    encoding: z.literal('utf-8'),
    rootElement: z.string().min(1),
    transformRules: z.array(TransformRuleSchema).optional(),
  })
  .strict();

/** Contract shape for `TextSchema` in src/curate/curator.ts. */
const TextContract = z
  .object({
    kind: z.literal('text'),
    encoding: z.literal('utf-8'),
    transformRules: z.array(TransformRuleSchema).optional(),
  })
  .strict();

/**
 * Head of the tabular contract asserted here for the datastore family (the full strict shape is
 * `tests/contract/curated-tabular-artifact.test.ts`; this checks the fields the datastore
 * dispatch is responsible for).
 */
const TabularHeadContract = z.object({
  kind: z.literal('tabular'),
  encoding: z.literal('utf-8'),
  rowFormat: z.literal('ndjson'),
  rowCount: z.number().int().min(0).nullable().optional(),
  columns: z
    .array(
      z.object({ canonicalName: z.string().regex(/^[a-z][a-z0-9_]*$/), sourceName: z.string() }),
    )
    .min(1),
});

function fakeResource(overrides: Partial<ResourceRow> = {}): ResourceRow {
  return {
    id: 'r1',
    dataset_id: 'd1',
    position: 0,
    name: 'r1',
    description_bg: null,
    declared_format: null,
    detected_content_type: null,
    detected_format: null,
    source_url: 'https://example.org/r1',
    bytes: null,
    sha256: null,
    raw_path: null,
    etag: null,
    last_modified: null,
    first_seen_at: '2026-07-08T00:00:00Z',
    last_synced_at: '2026-07-08T00:00:00Z',
    last_outcome: 'success',
    last_failure_reason: null,
    lifecycle_state: 'active',
    ...overrides,
  };
}

function assertValid(result: { success: boolean; error?: z.ZodError }): void {
  if (!result.success) throw new Error(JSON.stringify(result.error?.issues));
  expect(result.success).toBe(true);
}

const readCurated = (storeRoot: string, id: string, file: string): string =>
  readFileSync(join(storeRoot, 'curated', 'd1', id, file), 'utf-8');

describe('contract.curated-artifact-families', () => {
  it('JSON curator round-trips json-array.json: schema validates the json contract and data.json preserves the Cyrillic fixture value', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const out = await new JsonCurator().curate({
      storeRoot,
      resource: fakeResource({
        id: 'json1',
        declared_format: 'json',
        source_url: 'https://example.org/r.json',
      }),
      rawAbsPath: join(FIX, 'json-array.json'),
      curatorVersion: 'test',
    });
    expect(out.kind).toBe('json');
    assertValid(JsonShapeContract.safeParse(out.schema));
    expect((out.schema as { rootShape: string }).rootShape).toBe('array');
    const curated = readCurated(storeRoot, 'json1', 'data.json');
    expect(JSON.parse(curated)).toEqual(
      JSON.parse(readFileSync(join(FIX, 'json-array.json'), 'utf-8')),
    );
    expect(curated).toContain('София');
    expect(out.path.endsWith('data.json')).toBe(true);
  });

  it('GeoJSON curator round-trips geojson-sample.geojson: schema validates the geojson contract (feature_collection) with Cyrillic properties intact', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const out = await new GeoJsonCurator().curate({
      storeRoot,
      resource: fakeResource({
        id: 'geo1',
        declared_format: 'geojson',
        source_url: 'https://example.org/r.geojson',
      }),
      rawAbsPath: join(FIX, 'geojson-sample.geojson'),
      curatorVersion: 'test',
    });
    expect(out.kind).toBe('geojson');
    assertValid(JsonShapeContract.safeParse(out.schema));
    expect((out.schema as { rootShape: string }).rootShape).toBe('feature_collection');
    const curated = readCurated(storeRoot, 'geo1', 'data.json');
    expect(JSON.parse(curated)).toEqual(
      JSON.parse(readFileSync(join(FIX, 'geojson-sample.geojson'), 'utf-8')),
    );
    expect(curated).toContain('София');
  });

  it('XML curator round-trips xml-sample.xml: schema validates the xml contract with the root element identified and Cyrillic attributes intact', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const out = await new XmlCurator().curate({
      storeRoot,
      resource: fakeResource({
        id: 'xml1',
        declared_format: 'xml',
        source_url: 'https://example.org/r.xml',
      }),
      rawAbsPath: join(FIX, 'xml-sample.xml'),
      curatorVersion: 'test',
    });
    expect(out.kind).toBe('xml');
    assertValid(XmlContract.safeParse(out.schema));
    expect((out.schema as { rootElement: string }).rootElement).toBe('rows');
    // The fixture is already UTF-8, so the curated document is byte-identical to the raw source.
    expect(readCurated(storeRoot, 'xml1', 'data.xml')).toBe(
      readFileSync(join(FIX, 'xml-sample.xml'), 'utf-8'),
    );
    expect(readCurated(storeRoot, 'xml1', 'data.xml')).toContain('Пловдив');
  });

  it('Text curator round-trips text-cp1251.txt: CP1251 bytes decode to UTF-8 Cyrillic and the transform rule is declared', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const out = await new TextCurator().curate({
      storeRoot,
      resource: fakeResource({
        id: 'txt1',
        declared_format: 'txt',
        source_url: 'https://example.org/r.txt',
      }),
      rawAbsPath: join(FIX, 'text-cp1251.txt'),
      curatorVersion: 'test',
    });
    expect(out.kind).toBe('text');
    assertValid(TextContract.safeParse(out.schema));
    expect(readCurated(storeRoot, 'txt1', 'data.txt')).toBe('Отчет за бюджета\nСофия, 2026\n');
    expect(out.transformRules.some((r) => r.rule === 'utf8-from-windows1251')).toBe(true);
  });

  it('Datastore envelope (egov getResourceData.json) curates to a contract-valid tabular artifact: header flattened, NDJSON rows, Cyrillic preserved', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const out = await new DatastoreJsonCurator().curate({
      storeRoot,
      resource: fakeResource({
        id: 'ds1',
        declared_format: EGOV_DATASTORE_FORMAT,
        detected_format: EGOV_DATASTORE_FORMAT,
        source_url: 'https://data.egov.bg/data/view/d1',
      }),
      rawAbsPath: join(EGOV_FIX, 'getResourceData.json'),
      curatorVersion: 'test',
    });
    expect(out.kind).toBe('tabular');
    assertValid(TabularHeadContract.safeParse(out.schema));
    const schema = out.schema as {
      rowCount: number;
      columns: Array<{ sourceName: string }>;
    };
    // Header row consumed as column names (sourceName byte-exact, Principle X), 3 data rows left.
    expect(schema.columns.map((c) => c.sourceName)).toEqual([
      'РЕГИОН',
      'ВИД УСЛУГА',
      'ВИД ГОРИВО',
      'КЛАС ХИБРИД',
      'БРОЙ',
    ]);
    expect(schema.rowCount).toBe(3);
    const rows = readCurated(storeRoot, 'ds1', 'data.ndjson').trim().split('\n');
    expect(rows.length).toBe(3);
    const first = Object.values(JSON.parse(rows[0] as string) as Record<string, unknown>);
    expect(first).toContain('БЛАГОЕВГРАД');
    expect(first).toContain(43); // 'БРОЙ' inferred integer
    expect(out.path.endsWith('data.ndjson')).toBe(true);
  });
});
