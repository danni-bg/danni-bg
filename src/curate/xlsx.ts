import { closeSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { ensureDir } from '../lib/fs.ts';
import type {
  CurateContext,
  CuratedArtifactOutput,
  Curator,
  TabularSchema,
  TransformRule,
} from './curator.ts';
import { curatedRelDir } from './curator.ts';
import { normalizeBoolean, normalizeDate, normalizeDecimal } from './normalize.ts';
import { canonicalizeName, inferColumnType } from './schema.ts';

// ---------------------------------------------------------------------------
// Minimal, dependency-free OOXML (.xlsx) reader.
//
// An .xlsx file is a ZIP (OOXML) container. We parse the ZIP via its central
// directory and inflate DEFLATE-compressed parts with node:zlib — no heavy
// spreadsheet dependency. Only the subset of SpreadsheetML needed to recover
// a tabular grid per sheet is interpreted (workbook order, relationships,
// shared strings, inline/formula strings, booleans, numbers). Excel binary
// .xls (BIFF/OLE) and ZIP64 are intentionally unsupported in v1 and fall
// through to the uncurated marker via the orchestrator's try/catch.
// ---------------------------------------------------------------------------

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

function findEocd(buf: Buffer): number {
  const minOff = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= minOff; i--) {
    // Require the EOCD's comment to run exactly to end-of-file (spec invariant).
    // This rejects an EOCD signature that merely appears inside a trailing
    // archive comment, and selects the true record.
    if (buf.readUInt32LE(i) === SIG_EOCD && i + 22 + buf.readUInt16LE(i + 20) === buf.length) {
      return i;
    }
  }
  throw new Error('xlsx: end-of-central-directory record not found (not a zip archive)');
}

/** Parse a ZIP archive into a map of entry name → uncompressed bytes. */
export function unzipXlsx(buf: Buffer): Map<string, Buffer> {
  const eocd = findEocd(buf);
  const entryCount = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const files = new Map<string, Buffer>();
  for (let n = 0; n < entryCount; n++) {
    if (buf.readUInt32LE(off) !== SIG_CENTRAL) {
      throw new Error('xlsx: bad central-directory signature');
    }
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf-8', off + 46, off + 46 + nameLen);
    if (buf.readUInt32LE(localOff) !== SIG_LOCAL) {
      throw new Error('xlsx: bad local-header signature');
    }
    const localNameLen = buf.readUInt16LE(localOff + 26);
    const localExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + localNameLen + localExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(comp);
    else if (method === 8) data = inflateRawSync(comp);
    else throw new Error(`xlsx: unsupported compression method ${method}`);
    files.set(name, data);
    off += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function textOf(files: Map<string, Buffer>, name: string): string | undefined {
  const b = files.get(name);
  return b === undefined ? undefined : b.toString('utf-8');
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number.parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(attrs);
  return m ? (m[1] ?? null) : null;
}

/** Concatenate the decoded text of every base <t> element in a fragment. */
function collectText(fragment: string): string {
  // Phonetic-guide runs (<rPh>) are not part of the cell's logical value.
  const base = fragment.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  // `<t(?:\s[^>]*)?>` matches an opening <t> (optionally with attributes) but
  // NOT a self-closing <t/>, whose '/' would otherwise be swallowed by `[^>]*`
  // and corrupt multi-run shared/inline strings.
  for (const m of base.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) {
    out += decodeXmlEntities(m[1] ?? '');
  }
  return out;
}

function firstTagText(fragment: string, tag: string): string | null {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(fragment);
  return m ? (m[1] ?? '') : null;
}

/** xl/sharedStrings.xml → ordered string table. */
export function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)) {
    out.push(m[1] === undefined ? '' : collectText(m[1]));
  }
  return out;
}

/** xl/workbook.xml → ordered [{ name, rId }]. */
export function parseWorkbookSheets(xml: string): Array<{ name: string; rId: string | null }> {
  const out: Array<{ name: string; rId: string | null }> = [];
  for (const m of xml.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    const attrs = m[1] ?? '';
    const name = decodeXmlEntities(attr(attrs, 'name') ?? '');
    const rId = attr(attrs, 'r:id') ?? attr(attrs, 'r:ID');
    out.push({ name, rId });
  }
  return out;
}

/** xl/_rels/workbook.xml.rels → rId → target part name (under xl/). */
function parseRels(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of xml.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const attrs = m[1] ?? '';
    const id = attr(attrs, 'Id');
    const target = attr(attrs, 'Target');
    if (id && target) out.set(id, target);
  }
  return out;
}

export function resolveTarget(target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  return `xl/${target.replace(/^\.\//, '')}`;
}

function columnIndex(ref: string): number {
  const m = /^([A-Za-z]+)/.exec(ref);
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1] as string) {
    n = n * 26 + (ch.toUpperCase().charCodeAt(0) - 64);
  }
  return n - 1;
}

function cellValue(attrs: string, inner: string | undefined, shared: string[]): string {
  if (inner === undefined) return '';
  const t = attr(attrs, 't');
  if (t === 'inlineStr') return collectText(inner);
  if (t === 's') {
    const v = firstTagText(inner, 'v');
    const idx = v === null ? Number.NaN : Number.parseInt(v, 10);
    return Number.isInteger(idx) ? (shared[idx] ?? '') : '';
  }
  if (t === 'b') {
    const v = firstTagText(inner, 'v');
    if (v === '1') return 'true';
    if (v === '0') return 'false';
    return v ?? '';
  }
  // 'str' (cached formula string), 'n' / number, 'e' (error), or untyped.
  const v = firstTagText(inner, 'v');
  if (v !== null) return decodeXmlEntities(v);
  return collectText(inner);
}

/** Parse a worksheet part into a dense string grid (header in row 0). */
export function parseWorksheet(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const inner = rm[2];
    const cells: Array<{ idx: number; value: string }> = [];
    let auto = 0;
    if (inner !== undefined) {
      for (const cm of inner.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const cAttrs = cm[1] ?? '';
        const ref = attr(cAttrs, 'r');
        const idx = ref ? columnIndex(ref) : auto;
        auto = (idx < 0 ? auto : idx) + 1;
        cells.push({ idx: idx < 0 ? auto - 1 : idx, value: cellValue(cAttrs, cm[2], shared) });
      }
    }
    const width = cells.reduce((max, c) => Math.max(max, c.idx + 1), 0);
    const row = new Array<string>(width).fill('');
    for (const c of cells) row[c.idx] = c.value;
    rows.push(row);
  }
  return rows;
}

export interface ParsedSheet {
  name: string;
  rows: string[][];
}

/** Parse an .xlsx buffer into ordered sheets, each a dense string grid. */
export function parseXlsx(buf: Buffer): { sheets: ParsedSheet[] } {
  const files = unzipXlsx(buf);
  const wbXml = textOf(files, 'xl/workbook.xml');
  if (wbXml === undefined) throw new Error('xlsx: xl/workbook.xml not found');
  const relsXml = textOf(files, 'xl/_rels/workbook.xml.rels') ?? '';
  const sharedXml = textOf(files, 'xl/sharedStrings.xml');
  const shared = sharedXml === undefined ? [] : parseSharedStrings(sharedXml);
  const rels = parseRels(relsXml);
  const sheets: ParsedSheet[] = [];
  for (const def of parseWorkbookSheets(wbXml)) {
    const target = def.rId ? rels.get(def.rId) : undefined;
    const wsXml = target ? textOf(files, resolveTarget(target)) : undefined;
    if (wsXml === undefined) continue;
    sheets.push({ name: def.name, rows: parseWorksheet(wsXml, shared) });
  }
  return { sheets };
}

function sheetSlug(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
      .replace(/^-+|-+$/g, '') || 'sheet';
  let candidate = base;
  let n = 1;
  while (taken.has(candidate)) candidate = `${base}-${n++}`;
  taken.add(candidate);
  return candidate;
}

interface BuiltSheet {
  slug: string;
  sourceName: string;
  schema: TabularSchema;
  ndjson: string;
  rowCount: number;
  relPath: string;
}

function buildSheet(sheet: ParsedSheet, slug: string): BuiltSheet | null {
  const [headerRow, ...dataRows] = sheet.rows;
  if (!headerRow || headerRow.length === 0) return null;

  const taken = new Set<string>();
  const headers = headerRow.map((h) => canonicalizeName(h.trim() || 'col', taken));
  const transformRules: TransformRule[] = [
    { rule: 'xlsx-sheet', appliedTo: '*', params: { sheet: sheet.name } },
  ];

  const columnSamples: Record<string, Array<string | null>> = {};
  for (const key of headers) columnSamples[key] = [];
  for (const row of dataRows) {
    for (let i = 0; i < headers.length; i++) {
      const key = headers[i];
      if (typeof key !== 'string') continue;
      columnSamples[key]?.push(row[i] ?? null);
    }
  }

  const inferred = headers.map((h, i) => ({
    header: h,
    sourceName: headerRow[i] ?? h,
    inference: inferColumnType(columnSamples[h] ?? []),
  }));

  const schema: TabularSchema = {
    kind: 'tabular',
    encoding: 'utf-8',
    rowFormat: 'ndjson',
    rowCount: dataRows.length,
    columns: inferred.map((c) => ({
      canonicalName: c.header,
      sourceName: c.sourceName,
      labelBg: c.sourceName,
      type: c.inference.type as TabularSchema['columns'][number]['type'],
      nullable: c.inference.nullable,
      ...(c.inference.format ? { format: c.inference.format } : {}),
      interpretationConfidence: c.inference.confidence,
    })),
    transformRules,
  };

  const ndjsonLines = dataRows.map((row) => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < headers.length; i++) {
      const key = headers[i];
      if (typeof key !== 'string') continue;
      const raw = row[i] ?? '';
      const trimmed = raw.trim();
      if (trimmed === '') {
        obj[key] = null;
        continue;
      }
      switch (inferred[i]?.inference.type) {
        case 'integer':
        case 'decimal': {
          const num = normalizeDecimal(trimmed);
          obj[key] = num ? num.value : trimmed;
          break;
        }
        case 'date':
        case 'datetime': {
          const d = normalizeDate(trimmed);
          obj[key] = d ? d.iso : trimmed;
          break;
        }
        case 'boolean': {
          const b = normalizeBoolean(trimmed);
          obj[key] = b !== null ? b : trimmed;
          break;
        }
        default:
          obj[key] = raw;
      }
    }
    return JSON.stringify(obj);
  });

  return {
    slug,
    sourceName: sheet.name,
    schema,
    ndjson: `${ndjsonLines.join('\n')}\n`,
    rowCount: dataRows.length,
    relPath: '',
  };
}

export class XlsxCurator implements Curator {
  readonly kind: 'tabular';

  constructor() {
    this.kind = 'tabular';
  }

  canHandle(ctx: CurateContext): boolean {
    const fmt = (ctx.resource.declared_format ?? '').toLowerCase();
    if (fmt === 'xlsx') return true;
    if (ctx.resource.source_url.toLowerCase().endsWith('.xlsx')) return true;
    return ctx.rawAbsPath ? looksLikeXlsx(ctx.rawAbsPath) : false;
  }

  async curate(ctx: CurateContext): Promise<CuratedArtifactOutput> {
    const bytes = readFileSync(ctx.rawAbsPath);
    const { sheets } = parseXlsx(bytes);

    const baseDir = join(ctx.storeRoot, 'curated', curatedRelDir(ctx.resource));
    const curatedRoot = join(ctx.storeRoot, 'curated');
    // Re-curation may rename/drop sheets; clear the resource subtree first so no
    // stale per-sheet directories (or a prior non-xlsx artifact) survive.
    rmSync(baseDir, { recursive: true, force: true });
    const slugs = new Set<string>();
    const built: BuiltSheet[] = [];
    for (const sheet of sheets) {
      const slug = sheetSlug(sheet.name, slugs);
      const b = buildSheet(sheet, slug);
      if (!b) continue;
      const dir = join(baseDir, slug);
      ensureDir(dir);
      writeFileSync(join(dir, 'data.ndjson'), b.ndjson);
      writeFileSync(join(dir, 'schema.json'), `${JSON.stringify(b.schema, null, 2)}\n`);
      b.relPath = relative(curatedRoot, join(dir, 'data.ndjson'));
      built.push(b);
    }

    if (built.length === 0) {
      throw new Error(`xlsx: workbook has no curatable sheets (resource ${ctx.resource.id})`);
    }

    const first = built[0] as BuiltSheet;
    const transformRules: TransformRule[] = [
      { rule: 'xlsx-unzip', appliedTo: '*' },
      {
        rule: 'xlsx-workbook',
        appliedTo: '*',
        params: {
          sheets: built.map((b) => ({
            sourceName: b.sourceName,
            slug: b.slug,
            rowCount: b.rowCount,
            columns: b.schema.columns.length,
            path: b.relPath,
          })),
        },
      },
    ];

    return {
      kind: 'tabular',
      path: first.relPath,
      schema: first.schema,
      transformRules,
    };
  }
}

function looksLikeXlsx(path: string): boolean {
  try {
    // Cheap 2-byte magic check first; only read the whole file (to find the
    // workbook part) when the bytes actually start with the ZIP signature.
    if (!startsWithZipMagic(path)) return false;
    return readFileSync(path).includes(Buffer.from('xl/workbook.xml'));
  } catch {
    return false;
  }
}

export function startsWithZipMagic(path: string): boolean {
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(2);
    const n = readSync(fd, head, 0, 2, 0);
    return n >= 2 && head[0] === 0x50 && head[1] === 0x4b;
  } finally {
    closeSync(fd);
  }
}
