import { describe, expect, it } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CsvCurator } from '../../../src/curate/csv.ts';
import type { CurateContext } from '../../../src/curate/curator.ts';
import {
  DatastoreJsonCurator,
  flattenHeader,
  rowsToCsv,
} from '../../../src/curate/datastore-json.ts';
import { JsonCurator } from '../../../src/curate/json.ts';
import { CuratorRegistry } from '../../../src/curate/registry.ts';
import { ensureDir } from '../../../src/lib/fs.ts';
import { EGOV_DATASTORE_FORMAT, type ResourceRow } from '../../../src/store/repos/resources.ts';

function fakeResource(overrides: Partial<ResourceRow> = {}): ResourceRow {
  return {
    id: 'r1',
    dataset_id: 'd1',
    position: 0,
    name: 'r1',
    description_bg: null,
    declared_format: EGOV_DATASTORE_FORMAT,
    detected_content_type: null,
    detected_format: EGOV_DATASTORE_FORMAT,
    source_url: 'https://data.egov.bg/data/view/d1',
    bytes: null,
    sha256: null,
    raw_path: null,
    etag: null,
    last_modified: null,
    first_seen_at: '2026-07-03T00:00:00Z',
    last_synced_at: '2026-07-03T00:00:00Z',
    last_outcome: 'success',
    last_failure_reason: null,
    lifecycle_state: 'active',
    ...overrides,
  };
}

/** Write a verbatim datastore envelope to store/raw and return the curate context for `id`. */
function ctxFor(storeRoot: string, id: string, envelope: unknown): CurateContext {
  const dir = join(storeRoot, 'raw', 'd1', id);
  ensureDir(dir);
  const rawAbsPath = join(dir, 'raw.json');
  writeFileSync(rawAbsPath, JSON.stringify(envelope));
  return {
    storeRoot,
    resource: fakeResource({ id }),
    rawAbsPath,
    curatorVersion: 'v',
  };
}

const readCurated = (storeRoot: string, id: string, file: string): string =>
  readFileSync(join(storeRoot, 'curated', 'd1', id, file), 'utf-8');

describe('curate.datastore-json — moved CSV serialization', () => {
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
});

describe('curate.datastore-json — moved flattenHeader', () => {
  it('keeps a clean single-row header', () => {
    expect(
      flattenHeader([
        ['A', 'B'],
        ['1', '2'],
      ]),
    ).toEqual({ header: ['A', 'B'], dataStart: 1 });
  });

  it('merges a 2-row spreadsheet header (merged cells via forward-fill)', () => {
    const rows = [
      ['№', 'Group', '', 'Tail'],
      ['', 'Sub1', 'Sub2', ''],
      ['1', 'x', 'y', 'z'],
    ];
    const { header, dataStart } = flattenHeader(rows);
    expect(dataStart).toBe(2);
    expect(header).toEqual(['№', 'Group Sub1', 'Group Sub2', 'Tail']);
  });

  it('does NOT merge an all-text data row (no silent row loss)', () => {
    const rows = [
      ['Област', 'Община', ''],
      ['Благоевград', 'Банско', 'планински'],
      ['Видин', 'Белоградчик', 'равнинен'],
    ];
    const { header, dataStart } = flattenHeader(rows);
    expect(dataStart).toBe(1);
    expect(header).toEqual(['Област', 'Община', '']);
  });

  it('does not over-propagate a group label into a trailing column', () => {
    const rows = [
      ['A', 'G', '', 'B'],
      ['', 'S1', 'S2', ''],
      ['1', 'x', 'y', 'z'],
    ];
    expect(flattenHeader(rows).header).toEqual(['A', 'G S1', 'G S2', 'B']);
  });

  it('normalizes a width mismatch (row1 wider than row0)', () => {
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

  it('returns an empty header for empty rows', () => {
    expect(flattenHeader([])).toEqual({ header: [], dataStart: 0 });
  });
});

describe('curate.datastore-json — DatastoreJsonCurator', () => {
  it('array-of-arrays → the SAME tabular artifact as CSV-curating the flattened CSV (SC-2 parity)', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const rows = [
      ['РЕГИОН', 'ВИД', 'БРОЙ'],
      ['БЛАГОЕВГРАД', 'НОВО', '43'],
      ['ВИДИН', 'УПОТРЕБЯВАНО', '9'],
    ];

    // (a) The new path: curate the verbatim datastore envelope.
    const dsCtx = ctxFor(storeRoot, 'ds', { success: true, data: rows });
    const dsOut = await new DatastoreJsonCurator().curate(dsCtx);
    expect(dsOut.kind).toBe('tabular');

    // (b) The OLD two-stage path: sync serialized array-of-arrays → CSV, then CsvCurator ran on it.
    const csvDir = join(storeRoot, 'raw', 'd1', 'csv');
    ensureDir(csvDir);
    const csvPath = join(csvDir, 'raw.csv');
    writeFileSync(csvPath, rowsToCsv(rows)); // no merged header → single-row header
    const csvOut = await new CsvCurator().curate({
      storeRoot,
      resource: fakeResource({ id: 'csv', declared_format: 'csv' }),
      rawAbsPath: csvPath,
      curatorVersion: 'v',
    });

    // Byte-identical curated rows + equivalent schema (columns/rowCount/transformRules).
    expect(readCurated(storeRoot, 'ds', 'data.ndjson')).toBe(
      readCurated(storeRoot, 'csv', 'data.ndjson'),
    );
    expect(dsOut.schema).toEqual(csvOut.schema);
    expect(readCurated(storeRoot, 'ds', 'data.ndjson')).toBe(
      '{"region":"БЛАГОЕВГРАД","vid":"НОВО","broy":43}\n{"region":"ВИДИН","vid":"УПОТРЕБЯВАНО","broy":9}\n',
    );
  });

  it('flattens a 2-row merged header when curating the datastore envelope', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const ctx = ctxFor(storeRoot, 'merged', {
      success: true,
      data: [
        ['№ по ред', 'График', '', ''],
        ['', 'Тръгване', 'Връщане', ''],
        ['1', '08:00', '09:00', 'x'],
      ],
    });
    const out = await new DatastoreJsonCurator().curate(ctx);
    const cols = (out.schema as { columns: Array<{ canonicalName: string; sourceName: string }> })
      .columns;
    expect(cols.map((c) => c.canonicalName)).toContain('no_po_red');
    expect(cols.some((c) => /grafik_tragvane/.test(c.canonicalName))).toBe(true);
    expect((out.schema as { rowCount: number }).rowCount).toBe(1);
  });

  it('array-of-objects → JSON artifact (matches JsonCurator on the same value)', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const data = [
      { a: 1, b: 'x' },
      { a: 2, b: 'y' },
    ];
    const out = await new DatastoreJsonCurator().curate(
      ctxFor(storeRoot, 'objs', { success: true, data }),
    );
    expect(out.kind).toBe('json');
    // Equivalent to JsonCurator run directly on `data`.
    const jsonDir = join(storeRoot, 'raw', 'd1', 'plainjson');
    ensureDir(jsonDir);
    const jsonPath = join(jsonDir, 'raw.json');
    writeFileSync(jsonPath, JSON.stringify(data));
    await new JsonCurator().curate({
      storeRoot,
      resource: fakeResource({ id: 'plainjson', declared_format: 'json' }),
      rawAbsPath: jsonPath,
      curatorVersion: 'v',
    });
    expect(readCurated(storeRoot, 'objs', 'data.json')).toBe(
      readCurated(storeRoot, 'plainjson', 'data.json'),
    );
  });

  it('structured object document → JSON artifact (rootShape object)', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const out = await new DatastoreJsonCurator().curate(
      ctxFor(storeRoot, 'doc', { success: true, data: { version: '1.1', releases: [] } }),
    );
    expect(out.kind).toBe('json');
    expect((out.schema as { rootShape: string }).rootShape).toBe('object');
    expect(JSON.parse(readCurated(storeRoot, 'doc', 'data.json')).version).toBe('1.1');
  });

  it('plain-string datastore → verbatim text artifact', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const text = '+----+\n| No |\n+----+\n';
    const out = await new DatastoreJsonCurator().curate(
      ctxFor(storeRoot, 'txt', { success: true, data: text }),
    );
    expect(out.kind).toBe('text');
    expect(readCurated(storeRoot, 'txt', 'data.txt')).toBe(text);
  });

  it('normalizes an absent data field to an empty JSON array artifact', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const out = await new DatastoreJsonCurator().curate(
      ctxFor(storeRoot, 'empty', { success: true }),
    );
    expect(out.kind).toBe('json');
    expect(readCurated(storeRoot, 'empty', 'data.json').trim()).toBe('[]');
  });

  it('emits an empty JSON object artifact for a {} datastore', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    await new DatastoreJsonCurator().curate(ctxFor(storeRoot, 'obj', { success: true, data: {} }));
    expect(readCurated(storeRoot, 'obj', 'data.json').trim()).toBe('{}');
  });
});

describe('curate.datastore-json — registry selection & migration', () => {
  it('the registry selects DatastoreJsonCurator for an egov-datastore capture (FR-312)', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const ctx = ctxFor(storeRoot, 'sel', { success: true, data: [['A'], ['1']] });
    const selected = await new CuratorRegistry().select(ctx);
    expect(selected).toBeInstanceOf(DatastoreJsonCurator);
  });

  it('a plain JSON resource still routes to JsonCurator, not the datastore curator (FR-313)', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const dir = join(storeRoot, 'raw', 'd1', 'legacy-json');
    ensureDir(dir);
    const rawAbsPath = join(dir, 'raw.json');
    writeFileSync(rawAbsPath, '[1,2,3]');
    const selected = await new CuratorRegistry().select({
      storeRoot,
      resource: fakeResource({
        id: 'legacy-json',
        declared_format: 'json',
        detected_format: 'json',
        source_url: 'https://example.org/x.json',
      }),
      rawAbsPath,
      curatorVersion: 'v',
    });
    expect(selected).toBeInstanceOf(JsonCurator);
  });

  it('an already-captured legacy raw.csv still curates via the CSV curator (additive migration)', async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    const dir = join(storeRoot, 'raw', 'd1', 'legacy-csv');
    ensureDir(dir);
    const rawAbsPath = join(dir, 'raw.csv');
    writeFileSync(rawAbsPath, 'a,b\n1,2\n');
    const out = await new CuratorRegistry().curate({
      storeRoot,
      resource: fakeResource({
        id: 'legacy-csv',
        declared_format: 'csv',
        detected_format: 'csv',
        source_url: 'https://example.org/x.csv',
      }),
      rawAbsPath,
      curatorVersion: 'v',
    });
    expect(out.kind).toBe('tabular');
  });
});
