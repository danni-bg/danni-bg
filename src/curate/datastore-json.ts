import { readFileSync } from 'node:fs';
import { EGOV_DATASTORE_FORMAT } from '../store/repos/resources.ts';
import { curateCsvFromText } from './csv.ts';
import type { CurateContext, CuratedArtifactOutput, Curator } from './curator.ts';
import { curateJsonFromValue } from './json.ts';
import { curateTextFromString } from './text.ts';

// --- Datastore array-of-arrays → CSV serialization (moved verbatim from src/crawler/egov-sync.ts:
// capture must be byte-faithful, so ALL content transformation lives here in curate — spec 049
// FR-311/FR-315). ---

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Serialize datastore rows (array-of-arrays, header first) to CSV bytes. */
export function rowsToCsv(rows: unknown[]): string {
  return `${rows.map((r) => (Array.isArray(r) ? r.map(csvCell).join(',') : csvCell(r))).join('\n')}\n`;
}

function cellStr(v: unknown): string {
  return v === null || v === undefined ? '' : String(v).trim();
}

function toRow(r: unknown): string[] {
  return Array.isArray(r) ? r.map(cellStr) : [cellStr(r)];
}

function looksNumeric(s: string): boolean {
  return s !== '' && !Number.isNaN(Number(s.replace(/\s/g, '').replace(',', '.')));
}

/** A header-like row has at least one label and no numeric (data) cells. */
function isHeaderLike(row: string[]): boolean {
  const nonEmpty = row.filter((c) => c !== '');
  return nonEmpty.length > 0 && !nonEmpty.some(looksNumeric);
}

/**
 * Detect merged-group spans in row 0: a non-empty label at `start` followed by
 * ≥1 blank column that the sub-row labels (row1[i] non-empty). Returns the
 * columns to forward-fill the group label into. Empty when there is no group —
 * a label with only trailing/unlabeled blanks is NOT a merge.
 */
function groupFillColumns(row0: string[], row1: string[]): number[] {
  const fill: number[] = [];
  for (let i = 0; i < row0.length; i++) {
    if (row0[i] === '') continue;
    let j = i + 1;
    while (j < row0.length && row0[j] === '' && (row1[j] ?? '') !== '') {
      fill.push(j);
      j++;
    }
  }
  return fill;
}

/**
 * Collapse a 2-row datastore header into one header row. data.egov.bg serves
 * spreadsheet exports whose merged header cells span two rows (a top group label
 * with gaps + a sub-label row). Merging is GATED on positive evidence to avoid
 * ever consuming a real data row: row1 must be header-like (no numerics), the
 * row AFTER it (row2) must be data-like (numeric — shape divergence), and row0
 * must contain a genuine merged group whose blank columns are sub-labeled by
 * row1. Otherwise row0 is used as a single-row header (no rows dropped).
 *
 * Known limitation: 3+ band headers and right-edge-only groups are not merged
 * (treated as single-row header); a pathological all-text data row immediately
 * before a numeric row under a sub-labeled group could still be misread, but the
 * row2-data-like gate eliminates the common cases.
 */
export function flattenHeader(rows: unknown[]): { header: string[]; dataStart: number } {
  if (rows.length === 0) return { header: [], dataStart: 0 };
  const sample = rows.slice(0, 10).map(toRow);
  const width = Math.max(1, ...sample.map((r) => r.length));
  const pad = (r: string[]): string[] => {
    const a = r.slice();
    while (a.length < width) a.push('');
    return a;
  };
  const row0 = pad(toRow(rows[0]));
  const row1 = rows.length > 1 ? pad(toRow(rows[1])) : null;
  const row2 = rows.length > 2 ? pad(toRow(rows[2])) : null;

  const fillCols = row1 ? groupFillColumns(row0, row1) : [];
  const merge =
    row1 !== null &&
    row2 !== null &&
    isHeaderLike(row1) &&
    !isHeaderLike(row2) && // the row after the sub-row must be data
    fillCols.length > 0; // row0 has a genuine sub-labeled merged group

  if (!merge || row1 === null) return { header: row0, dataStart: 1 };

  const top = [...row0];
  for (const c of fillCols) {
    // fill from the nearest non-empty label to the left (the group's label)
    for (let k = c - 1; k >= 0; k--) {
      if (top[k] !== '') {
        top[c] = top[k] as string;
        break;
      }
    }
  }
  const header = top.map((t, i) => [t, row1[i] ?? ''].filter((x) => x !== '').join(' '));
  return { header, dataStart: 2 };
}

/**
 * Curator for a byte-faithful egov datastore capture (spec 049). The raw artifact is the verbatim
 * `getResourceData` response envelope (`{success, data}`); this curator owns everything the sync
 * used to do at capture time: unwrap the envelope, normalize an absent/`{}`/`null` data field to an
 * empty artifact, and dispatch on the serialized `data` shape —
 *   - array-of-arrays  → CSV (incl. 2-row merged-header flattening) → the CSV curator's tabular path
 *   - array-of-objects / structured document → the JSON curator's normalized JSON
 *   - plain string     → the text curator's verbatim `data.txt`
 * producing outputs identical to the previous capture-time transform + generic curator (FR-311, SC-2).
 *
 * Selected by the registry for these captures via the recorded `EGOV_DATASTORE_FORMAT` hint, ahead
 * of the generic `JsonCurator` (FR-312). Already-captured `raw.{csv,json,txt}` archives keep their
 * legacy hints and still curate through the CSV/JSON/Text curators, so migration is additive (FR-313).
 */
export class DatastoreJsonCurator implements Curator {
  // The verbatim raw is always a JSON envelope, so it sniffs as `json`; being the first json-kind
  // curator, the registry probes this one first and its hint gate decides (FR-312).
  readonly kind = 'json' as const;

  canHandle(ctx: CurateContext): boolean {
    return (
      (ctx.resource.declared_format ?? '').toLowerCase() === EGOV_DATASTORE_FORMAT ||
      (ctx.resource.detected_format ?? '').toLowerCase() === EGOV_DATASTORE_FORMAT
    );
  }

  async curate(ctx: CurateContext): Promise<CuratedArtifactOutput> {
    const raw = readFileSync(ctx.rawAbsPath, 'utf-8');
    const envelope = JSON.parse(raw) as { data?: unknown };
    // An absent/`null` data field (the live API answers `{"success":true}` for an empty datastore)
    // normalizes to an empty array — the same defaulting the sync used to apply at capture.
    const data = envelope.data ?? [];
    if (typeof data === 'string') {
      return curateTextFromString(data, ctx);
    }
    if (Array.isArray(data) && Array.isArray(data[0])) {
      const { header, dataStart } = flattenHeader(data);
      return curateCsvFromText(rowsToCsv([header, ...data.slice(dataStart)]), ctx);
    }
    return curateJsonFromValue(data, ctx);
  }
}
