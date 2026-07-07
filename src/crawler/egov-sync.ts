import type { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScopeConfig } from '../config/schema.ts';
import { atomicWriteFile, safePathSegment } from '../lib/fs.ts';
import { sha256Hex } from '../lib/hash.ts';
import { nowIso } from '../lib/time.ts';
import { withContext } from '../logging/logger.ts';
import type { SyncRunHandle } from '../manifest/sync-run.ts';
import type {
  ManifestDatasetEntry,
  ManifestResourceEntry,
  ManifestTotals,
} from '../manifest/writer.ts';
import { CrawlCheckpointsRepo } from '../store/repos/crawl-checkpoints.ts';
import { DatasetsRepo } from '../store/repos/datasets.ts';
import { OrganizationsRepo } from '../store/repos/organizations.ts';
import { ResourcesRepo } from '../store/repos/resources.ts';
import { decideDatasetSkip } from './crawl-checkpoint.ts';
import type { EgovBgClient } from './egov-bg-client.ts';
import { datasetValidator } from './egov-validator.ts';
import { buildScopePredicate, egovPublisherId } from './scope.ts';

export interface EgovSyncOptions {
  db: Database;
  storeRoot: string;
  client: EgovBgClient;
  /** The Sync Run lifecycle handle (FR-007); events/totals flow through it. */
  handle: SyncRunHandle;
  /** Campaign key (FR-003a) under which checkpoint progress is recorded. */
  scopeHash: string;
  /**
   * The active scope, applied as a per-dataset in-scope check against the full getDatasetDetails
   * (spec 048, FR-301) — resolves tags (absent from the enumeration summary) and confirms
   * publisher; an out-of-scope dataset is recorded as outOfScope, never captured.
   */
  scope: ScopeConfig;
  /** Ordered dataset uris to process this session (from the resume planner). */
  uris: string[];
  /** Re-attempt sub-cap recorded failures (FR-009). */
  retryFailed?: boolean | undefined;
  locale?: string;
}

export interface EgovSyncResult {
  datasets: number;
  resources: number;
  captured: number;
  skippedUnchanged: number;
  failures: number;
  totals: ManifestTotals;
  datasetEntries: ManifestDatasetEntry[];
}

const MAX_ORG_PAGES = 12;
const PAGE_SIZE = 100;

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'item'
  );
}

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

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Discover datasets from data.egov.bg's custom API and capture each resource's datastore content
 * into the store. Runs INSIDE a Sync Run (FR-007): events/totals flow through the passed
 * `SyncRunHandle`, captures are atomic (temp + fsync + rename — FR-005), and per-dataset/
 * per-resource progress is recorded in `crawl_checkpoints` so an interrupted crawl resumes without
 * re-fetching captured-unchanged content (FR-001/2/3). The cursor advances per dataset; completion
 * is recorded per resource so an interruption loses at most one in-flight resource (SC-004).
 */
export async function runEgovSync(opts: EgovSyncOptions): Promise<EgovSyncResult> {
  const log = withContext({ component: 'egov-sync', run_id: opts.handle.runId });
  const datasetsRepo = new DatasetsRepo(opts.db);
  const resourcesRepo = new ResourcesRepo(opts.db);
  const orgsRepo = new OrganizationsRepo(opts.db);
  const checkpoint = new CrawlCheckpointsRepo(opts.db);
  const locale = opts.locale ?? 'bg';
  // Per-dataset in-scope check (FR-301): the same predicate the CKAN path uses, now over the full
  // egov details (publisher + tags), so scope means the same thing on both adapters (FR-305/SC-4).
  const inScope = buildScopePredicate(opts.scope);

  const orgCache = new Map<number, { uri: string; name: string }>();
  let orgPagesLoaded = 0;
  const resolveOrg = async (orgId: number | null | undefined): Promise<string | null> => {
    if (orgId === null || orgId === undefined) return null;
    while (!orgCache.has(orgId) && orgPagesLoaded < MAX_ORG_PAGES) {
      const page = orgPagesLoaded + 1;
      const resp = await opts.client.listOrganisations({
        recordsPerPage: PAGE_SIZE,
        pageNumber: page,
      });
      for (const o of resp.organisations) {
        if (typeof o.id === 'number') orgCache.set(o.id, { uri: o.uri, name: o.name });
      }
      orgPagesLoaded = page;
      if (resp.organisations.length < PAGE_SIZE) break;
    }
    const found = orgCache.get(orgId);
    const id = `egov-org-${orgId}`;
    orgsRepo.upsert({
      id,
      slug: found ? slugify(found.name) : id,
      titleBg: found ? found.name : `Организация ${orgId}`,
      sourceUrl: found
        ? `https://data.egov.bg/organisation/profile/${found.uri}`
        : 'https://data.egov.bg/',
    });
    return id;
  };

  const totals: ManifestTotals = {
    discovered: 0,
    captured: 0,
    skippedUnchanged: 0,
    failed: 0,
    withdrawn: 0,
    outOfScope: 0,
  };
  const datasetEntries: ManifestDatasetEntry[] = [];
  let datasets = 0;
  let resources = 0;

  // --retry-failed: re-open sub-cap recorded failures back to pending so they are re-attempted.
  if (opts.retryFailed) {
    for (const uri of checkpoint.listRetryableFailed(opts.scopeHash)) {
      checkpoint.reopenDataset(opts.scopeHash, uri);
    }
  }

  for (const uri of opts.uris) {
    totals.discovered += 1;
    opts.handle.recordEvent({ datasetId: uri, outcome: 'discovered' });

    let details: Awaited<ReturnType<EgovBgClient['getDatasetDetails']>>;
    try {
      details = await opts.client.getDatasetDetails(uri, locale);
    } catch (err) {
      log.warn('egov.dataset.skip', { uri, error: msg(err) });
      totals.failed += 1;
      checkpoint.upsertDataset({ scopeHash: opts.scopeHash, datasetUri: uri });
      checkpoint.markDatasetFailed(opts.scopeHash, uri, msg(err));
      opts.handle.recordEvent({ datasetId: uri, outcome: 'failed', failureReason: msg(err) });
      checkpoint.advanceCursor(opts.scopeHash, uri, opts.handle.runId);
      continue;
    }
    const d = details.data;

    // Per-dataset in-scope check (spec 048, FR-301/303): the enumeration summary can't carry tags,
    // so a candidate frozen for a tag scope (or one whose publisher drifted) is confirmed here
    // against the full details. Out-of-scope → recorded as outOfScope, NEVER captured; the cursor
    // advances and the dataset is marked done so a bounded session doesn't revisit it.
    const tags = (d.tags ?? []).map((t) => t.name);
    if (
      !inScope({ id: d.uri, slug: slugify(d.name), publisherId: egovPublisherId(d.org_id), tags })
    ) {
      totals.outOfScope += 1;
      opts.handle.recordEvent({ datasetId: uri, outcome: 'out_of_scope' });
      checkpoint.upsertDataset({ scopeHash: opts.scopeHash, datasetUri: uri });
      checkpoint.markDatasetComplete(opts.scopeHash, uri);
      checkpoint.advanceCursor(opts.scopeHash, uri, opts.handle.runId);
      continue;
    }

    const validator = datasetValidator(details);

    // Dataset-level skip (FR-002): validator unchanged AND all resources captured.
    if (decideDatasetSkip({ db: opts.db, scopeHash: opts.scopeHash, datasetUri: uri, validator })) {
      datasets += 1;
      totals.skippedUnchanged += 1;
      opts.handle.recordEvent({ datasetId: uri, outcome: 'skipped_unchanged' });
      checkpoint.advanceCursor(opts.scopeHash, uri, opts.handle.runId);
      continue;
    }

    const publisherId = await resolveOrg(d.org_id);
    datasetsRepo.upsert({
      id: d.uri,
      slug: slugify(d.name),
      titleBg: d.name,
      // The portal returns `descript: 0` (number) for an empty description.
      descriptionBg: typeof d.descript === 'string' && d.descript.length > 0 ? d.descript : null,
      publisherId,
      tags: (d.tags ?? []).map((t) => t.name),
      groups: [],
      sourceUrl: `https://data.egov.bg/data/view/${d.uri}`,
      // Source timestamps from the egov package (the portal's "Създаден на" / "Последна промяна").
      // Without these, freshness can only fall back to crawl time (last_synced_at), making every
      // dataset read "stale" once a crawl ages — even when the source is current.
      metadataCreated: d.created_at ?? null,
      metadataModified: d.updated_at ?? null,
      sourceEtagOrHash: validator,
    });
    datasets += 1;

    let resList: Awaited<ReturnType<EgovBgClient['listResources']>>;
    try {
      resList = await opts.client.listResources(d.uri);
    } catch (err) {
      log.warn('egov.resources.skip', { uri, error: msg(err) });
      checkpoint.upsertDataset({ scopeHash: opts.scopeHash, datasetUri: uri, validator });
      checkpoint.markDatasetFailed(opts.scopeHash, uri, msg(err));
      totals.failed += 1;
      opts.handle.recordEvent({ datasetId: uri, outcome: 'failed', failureReason: msg(err) });
      datasetEntries.push({
        datasetId: uri,
        sourceUrl: `https://data.egov.bg/data/view/${uri}`,
        outcome: 'failed',
        lifecycleState: 'active',
        capturedAt: nowIso(),
        metadataHash: validator,
        failureReason: msg(err),
        resources: [],
      });
      checkpoint.advanceCursor(opts.scopeHash, uri, opts.handle.runId);
      continue;
    }

    checkpoint.upsertDataset({
      scopeHash: opts.scopeHash,
      datasetUri: uri,
      validator,
      resourceCount: resList.resources.length,
    });

    const resourceEntries: ManifestResourceEntry[] = [];
    let datasetOutcome: 'captured' | 'skipped_unchanged' | 'failed' = 'skipped_unchanged';
    let datasetHadFailure = false;

    for (const r of resList.resources) {
      resources += 1;
      checkpoint.upsertResource({
        scopeHash: opts.scopeHash,
        datasetUri: uri,
        resourceUri: r.uri,
      });

      // Per-resource skip: an already-success row under the CURRENT validator is reused (FR-002).
      const prior = checkpoint.getResource(opts.scopeHash, uri, r.uri);
      if (prior && prior.outcome === 'success' && prior.validator === validator) {
        totals.skippedUnchanged += 1;
        opts.handle.recordEvent({
          datasetId: uri,
          resourceId: r.uri,
          outcome: 'skipped_unchanged',
        });
        resourceEntries.push({
          resourceId: r.uri,
          sourceUrl: r.resource_url || `https://data.egov.bg/data/view/${uri}`,
          outcome: 'skipped_unchanged',
        });
        continue;
      }

      const formatHint = r.file_format ? r.file_format.toLowerCase() : null;
      const baseResource = {
        id: r.uri,
        datasetId: d.uri,
        sourceUrl: r.resource_url || `https://data.egov.bg/data/view/${d.uri}`,
        name: r.name ?? null,
      };
      let data: unknown[] | Record<string, unknown> | string;
      try {
        // An absent `data` field — the live API returns `{"success":true}` for an empty
        // datastore — normalizes to an empty array, captured below as a valid empty artifact.
        data = (await opts.client.getResourceData(r.uri)).data ?? [];
      } catch (err) {
        log.warn('egov.capture.fail', { resource: r.uri, error: msg(err) });
        resourcesRepo.upsert({ ...baseResource, declaredFormat: formatHint });
        resourcesRepo.recordOutcome(r.uri, 'failure', msg(err));
        checkpoint.markResourceFailed({
          scopeHash: opts.scopeHash,
          datasetUri: uri,
          resourceUri: r.uri,
          reason: msg(err),
        });
        totals.failed += 1;
        datasetHadFailure = true;
        opts.handle.recordEvent({
          datasetId: uri,
          resourceId: r.uri,
          outcome: 'failed',
          failureReason: msg(err),
        });
        resourceEntries.push({
          resourceId: r.uri,
          sourceUrl: baseResource.sourceUrl,
          outcome: 'failed',
          failureReason: msg(err),
        });
        continue;
      }
      // An empty datastore (no rows, `{}`, or an absent `data` field) is a VALID empty
      // resource, not a failure: it serializes to an empty artifact (`[]`/`{}`) below and is
      // recorded as a successful capture. Counting it as a failure previously inflated the
      // per-resource failure rate (~38% of a live sample) and tripped the SC-001 ≥95% SLO for
      // a non-error condition.
      // The serialized shape — not the portal's file_format — is authoritative for
      // curator selection. Tabular datastore (array-of-arrays) → CSV; an array-of-objects
      // or a single structured document (e.g. OCDS) → JSON; a plain-string datastore
      // (a pre-formatted free-text/ASCII table) → TXT, written verbatim.
      const ext =
        typeof data === 'string'
          ? 'txt'
          : Array.isArray(data) && Array.isArray(data[0])
            ? 'csv'
            : 'json';
      let content: string;
      if (ext === 'txt') {
        content = data as string;
      } else if (ext === 'csv') {
        const rows = data as unknown[];
        const { header, dataStart } = flattenHeader(rows);
        content = rowsToCsv([header, ...rows.slice(dataStart)]);
      } else {
        content = `${JSON.stringify(data, null, 2)}\n`;
      }
      const rawPath = join(safePathSegment(d.uri), safePathSegment(r.uri), `raw.${ext}`);
      const absPath = join(opts.storeRoot, 'raw', rawPath);
      const buf = Buffer.from(content, 'utf-8');
      const sha256 = sha256Hex(buf);
      // FR-008 on-disk content reuse: if the file already holds these exact bytes (e.g. a safe
      // re-scan after a lost checkpoint), skip the re-write entirely (reuse-on-match, mirrors
      // BlobStore.put). Otherwise FR-005/SC-003: temp + fsync + rename, recording ONLY after rename.
      const onDiskMatches = existsSync(absPath) && sha256Hex(readFileSync(absPath)) === sha256;
      if (!onDiskMatches) {
        atomicWriteFile(absPath, content);
      }
      resourcesRepo.upsert({ ...baseResource, declaredFormat: ext });
      resourcesRepo.recordCapture({
        id: r.uri,
        bytes: buf.byteLength,
        sha256,
        rawPath,
        detectedFormat: ext,
        outcome: 'success',
      });
      checkpoint.markResourceSuccess({
        scopeHash: opts.scopeHash,
        datasetUri: uri,
        resourceUri: r.uri,
        sha256,
        validator,
      });
      totals.captured += 1;
      datasetOutcome = 'captured';
      opts.handle.recordEvent({
        datasetId: uri,
        resourceId: r.uri,
        outcome: 'captured',
        bytes: buf.byteLength,
        sha256,
      });
      resourceEntries.push({
        resourceId: r.uri,
        sourceUrl: baseResource.sourceUrl,
        outcome: 'captured',
        bytes: buf.byteLength,
        sha256,
        rawPath,
        declaredFormat: ext,
      });
    }

    if (datasetHadFailure) {
      checkpoint.markDatasetFailed(opts.scopeHash, uri, 'one or more resources failed');
      datasetOutcome = 'failed';
    } else {
      checkpoint.markDatasetComplete(opts.scopeHash, uri);
    }
    datasetEntries.push({
      datasetId: uri,
      sourceUrl: `https://data.egov.bg/data/view/${uri}`,
      outcome: datasetOutcome,
      lifecycleState: 'active',
      capturedAt: nowIso(),
      metadataHash: validator,
      resources: resourceEntries,
    });
    // Advance the cursor only after the dataset fully completes (clean session boundary, R6).
    checkpoint.advanceCursor(opts.scopeHash, uri, opts.handle.runId);
  }

  log.info('egov.completed', {
    datasets,
    resources,
    captured: totals.captured,
    skipped: totals.skippedUnchanged,
    failures: totals.failed,
  });
  return {
    datasets,
    resources,
    captured: totals.captured,
    skippedUnchanged: totals.skippedUnchanged,
    failures: totals.failed,
    totals,
    datasetEntries,
  };
}
