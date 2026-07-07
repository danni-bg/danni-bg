import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ensureDir } from '../lib/fs.ts';
import type { ResourceRow } from '../store/repos/resources.ts';
import type {
  CurateContext,
  CuratedArtifactOutput,
  Curator,
  TabularSchema,
  TransformRule,
} from './curator.ts';
import { curatedRelDir } from './curator.ts';
import { type DetectedEncoding, decodeBytes, detectEncoding } from './encoding.ts';
import { normalizeBoolean, normalizeDate, normalizeDecimal } from './normalize.ts';
import { canonicalizeName, inferColumnType } from './schema.ts';
import { startsWithZipMagic } from './xlsx.ts';

interface ParsedCsv {
  delimiter: ',' | ';' | '\t';
  rows: string[][];
  rawHeader: string[];
}

function sniffDelimiter(line: string): ',' | ';' | '\t' {
  const counts = {
    ',': (line.match(/,/g) ?? []).length,
    ';': (line.match(/;/g) ?? []).length,
    '\t': (line.match(/\t/g) ?? []).length,
  } as const;
  if (counts[';'] > counts[',']) return ';';
  if (counts['\t'] > counts[',']) return '\t';
  return ',';
}

function parseCsv(text: string): ParsedCsv {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const firstNonEmpty = lines.find((l) => l.length > 0) ?? '';
  const delim = sniffDelimiter(firstNonEmpty);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (const line of lines) {
    let i = 0;
    while (i < line.length) {
      const c = line[i];
      if (inQuotes) {
        if (c === '"') {
          if (line[i + 1] === '"') {
            cell += '"';
            i += 2;
            continue;
          }
          inQuotes = false;
          i++;
          continue;
        }
        cell += c;
        i++;
        continue;
      }
      if (c === '"') {
        inQuotes = true;
        i++;
        continue;
      }
      if (c === delim) {
        row.push(cell);
        cell = '';
        i++;
        continue;
      }
      cell += c;
      i++;
    }
    if (inQuotes) {
      cell += '\n';
      continue;
    }
    row.push(cell);
    rows.push(row);
    row = [];
    cell = '';
  }
  if (rows.length > 0 && rows[rows.length - 1]?.length === 1 && rows[rows.length - 1]?.[0] === '') {
    rows.pop();
  }
  const header = rows.shift() ?? [];
  return { delimiter: delim, rows, rawHeader: header };
}

export class CsvCurator implements Curator {
  readonly kind = 'tabular' as const;

  canHandle(ctx: CurateContext): boolean {
    const fmt = (ctx.resource.declared_format ?? '').toLowerCase();
    const nameMatch =
      fmt === 'csv' || fmt === 'tsv' || ctx.resource.source_url.toLowerCase().endsWith('.csv');
    if (!nameMatch) return false;
    // A genuine CSV never begins with the ZIP local-file magic ('PK'). Reject
    // such bytes so an .xlsx mislabeled csv (wrong declared_format / URL) falls
    // through to the XLSX curator instead of being silently mangled as text.
    if (!ctx.rawAbsPath) return true;
    try {
      return !startsWithZipMagic(ctx.rawAbsPath);
    } catch {
      return true;
    }
  }

  async curate(ctx: CurateContext): Promise<CuratedArtifactOutput> {
    const bytes = readFileSync(ctx.rawAbsPath);
    const detection = detectEncoding(bytes);
    const text = decodeBytes(bytes, detection.encoding);
    const preRules: TransformRule[] = [];
    if (detection.encoding === 'cp1251') {
      preRules.push({
        rule: 'utf8-from-windows1251',
        appliedTo: '*',
        params: { reason: detection.reason, confidence: detection.confidence },
      });
    } else if (detection.reason === 'bom') {
      preRules.push({ rule: 'cyrillic-strip-bom', appliedTo: '*' });
    }
    return curateCsvFromText(text, ctx, preRules);
  }
}

/**
 * Curate already-decoded UTF-8 CSV text into an ndjson tabular artifact + schema. Split from
 * `CsvCurator.curate` so an in-memory producer (the datastore-JSON curator, which serializes egov
 * array-of-arrays rows to CSV) reuses the exact same parse → type-inference → ndjson path, keeping
 * the two entry points byte-identical (spec 049 SC-2). `preRules` carries any transform already
 * applied to reach this text (e.g. an encoding conversion done by the byte-reading caller).
 */
export function curateCsvFromText(
  text: string,
  ctx: CurateContext,
  preRules: TransformRule[] = [],
): CuratedArtifactOutput {
  {
    const transformRules: TransformRule[] = [...preRules];
    const parsed = parseCsv(text);
    transformRules.push({
      rule: 'csv-parse',
      appliedTo: '*',
      params: { delimiter: parsed.delimiter },
    });

    const taken = new Set<string>();
    const headers = parsed.rawHeader.map((h) => canonicalizeName(h.trim() || 'col', taken));
    const columnSamples: Record<string, Array<string | null>> = {};
    for (let i = 0; i < headers.length; i++) {
      const key = headers[i];
      if (typeof key !== 'string') continue;
      columnSamples[key] = [];
    }
    for (const row of parsed.rows) {
      for (let i = 0; i < headers.length; i++) {
        const key = headers[i];
        if (typeof key !== 'string') continue;
        const v = row[i];
        const arr = columnSamples[key];
        if (!arr) continue;
        arr.push(v ?? null);
      }
    }
    const inferred = headers.map((h, i) => ({
      header: h,
      sourceName: parsed.rawHeader[i] ?? h,
      inference: inferColumnType(columnSamples[h] ?? []),
    }));

    const schema: TabularSchema = {
      kind: 'tabular',
      encoding: 'utf-8',
      rowFormat: 'ndjson',
      rowCount: parsed.rows.length,
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

    const ndjsonLines = parsed.rows.map((row) => {
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < headers.length; i++) {
        const key = headers[i];
        if (typeof key !== 'string') continue;
        const raw = row[i] ?? '';
        const inf = inferred[i]?.inference;
        const trimmed = raw.trim();
        if (trimmed === '') {
          obj[key] = null;
          continue;
        }
        switch (inf?.type) {
          case 'integer':
          case 'decimal': {
            const n = normalizeDecimal(trimmed);
            obj[key] = n ? n.value : trimmed;
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

    const relPath = computeRel(ctx.resource);
    const dir = join(ctx.storeRoot, 'curated', relPath);
    ensureDir(dir);
    writeFileSync(join(dir, 'data.ndjson'), `${ndjsonLines.join('\n')}\n`);
    writeFileSync(join(dir, 'schema.json'), `${JSON.stringify(schema, null, 2)}\n`);
    return {
      kind: 'tabular',
      path: relative(join(ctx.storeRoot, 'curated'), join(dir, 'data.ndjson')),
      schema,
      transformRules,
    };
  }
}

function _refUnused(_x: DetectedEncoding): void {
  // type-import keepalive (no-op)
}

function computeRel(resource: ResourceRow): string {
  return curatedRelDir(resource);
}

void _refUnused;
