import type { Database } from 'bun:sqlite';
import { type CuratedArtifactRow, CuratedArtifactsRepo } from '../store/repos/curated-artifacts.ts';
import { DatasetsRepo } from '../store/repos/datasets.ts';
import { EntitiesRepo } from '../store/repos/entities.ts';
import { OrganizationsRepo } from '../store/repos/organizations.ts';
import { TranslationsRepo } from '../store/repos/translations.ts';
import type { Embedder } from './embedder.ts';
import { type VectorMatrix, getVectorMatrix } from './vector-cache.ts';

export type Lang = 'bg' | 'en' | 'auto';

export interface IndexEntry {
  datasetId: string;
  score: number;
  matchKind: 'keyword' | 'semantic' | 'hybrid' | 'entity';
  title: {
    bg: string;
    en: string | null;
    translator: string | null;
    translationConfidence: number | null;
  };
  snippet?: string | null;
  publisher: {
    id: string;
    title: {
      bg: string;
      en: string | null;
      translator: string | null;
      translationConfidence: number | null;
    };
  } | null;
  matchedEntities?: Array<{
    entityId: string;
    kind: string;
    label: { bg: string; en: string | null };
  }>;
  sourceUrl: string;
  curatedDatasetPath: string;
  freshness: {
    lastSyncedAt: string;
    sourceLastModified: string | null;
    sourceEtagOrHash: string | null;
    isStale: boolean;
    freshnessSloSeconds: number;
  };
}

export interface QueryOptions {
  db: Database;
  embedder: Embedder;
  query: string;
  lang?: Lang;
  limit?: number;
  freshnessSloSeconds?: number;
}

function escapeFts(query: string): string {
  // FTS5 strips problematic chars; double-quote each token to avoid syntax errors.
  return query
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' ');
}

function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  const mag = Math.sqrt(na) * Math.sqrt(nb);
  return mag === 0 ? 0 : dot / mag;
}

interface ScoredCandidate {
  datasetId: string;
  ftsRank?: number | undefined;
  vecRank?: number | undefined;
}

/**
 * Relative path under store/curated/ to the dataset's curated record (FR-013).
 * Curated artifacts live at `<datasetId>/<resourceId>/data.*`, so the dataset-level
 * record is that directory; a consumer enumerates the per-resource artifacts within it
 * (see `danni mirror-info`). Derived from a real curated artifact when one exists so the
 * pointer is grounded in actual on-disk output, falling back to the dataset id (the
 * canonical curated directory) when the dataset has no curated artifacts yet.
 */
function resolveCuratedDatasetPath(artifacts: CuratedArtifactRow[], datasetId: string): string {
  const withPath = artifacts.find((a) => a.path.length > 0);
  const top = withPath?.path.split(/[/\\]/)[0];
  return top && top.length > 0 ? top : datasetId;
}

const RRF_K = 60;

/** Depth of each retrieval leg (FTS + vector) fed into the RRF fusion. */
const CANDIDATE_DEPTH = 50;

/** A fused, ranked hit before DB projection — the O(candidates) output of the ranking phase. */
export interface RankedHit {
  datasetId: string;
  score: number;
  matchKind: IndexEntry['matchKind'];
}

/**
 * Top-K by cosine over the resident matrix, allocating O(K) (spec 050 FR-320): instead of scoring
 * every vector into an O(corpus) array and sorting it, keep a size-K list sorted descending and only
 * admit a vector that beats the current K-th score. Ranking work is still O(corpus) (a brute-force
 * scan is inherent without an ANN index), but allocation is bounded to the candidate set.
 */
function topKCosine(
  matrix: VectorMatrix,
  queryVec: Float32Array,
  k: number,
): Array<{ datasetId: string; score: number }> {
  const top: Array<{ datasetId: string; score: number }> = [];
  const insert = (datasetId: string, score: number): void => {
    let lo = 0;
    let hi = top.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((top[mid]?.score ?? Number.NEGATIVE_INFINITY) >= score) lo = mid + 1;
      else hi = mid;
    }
    top.splice(lo, 0, { datasetId, score });
  };
  for (let i = 0; i < matrix.ids.length; i++) {
    const id = matrix.ids[i];
    const vec = matrix.vectors[i];
    if (id === undefined || vec === undefined) continue;
    const score = cosine(queryVec, vec);
    if (top.length < k) {
      insert(id, score);
    } else if (score > (top[top.length - 1]?.score ?? Number.NEGATIVE_INFINITY)) {
      top.pop();
      insert(id, score);
    }
  }
  return top;
}

/**
 * The ranking phase of hybrid search (spec 050): FTS5 keyword rank ⊕ vector cosine rank fused by RRF,
 * yielding ranked (datasetId, score, matchKind) pairs. Bounded work per query — one FTS query, one
 * query embedding, a scan of the cached matrix — with NO per-hit DB projection, so a caller that only
 * needs ids+scores (the explorer search route, which re-projects hits through the bulk `listLite`
 * path) pays O(candidates), not O(hits) point queries. `search()` layers projection on top.
 */
export async function searchRanked(opts: QueryOptions): Promise<RankedHit[]> {
  const limit = opts.limit ?? 5;

  const ftsResults = opts.db
    .query<{ dataset_id: string }, [string]>(
      'SELECT dataset_id FROM datasets_fts WHERE datasets_fts MATCH ? ORDER BY rank LIMIT 50',
    )
    .all(escapeFts(opts.query));

  const ftsRanks = new Map<string, number>();
  ftsResults.forEach((r, i) => ftsRanks.set(r.dataset_id, i + 1));

  const matrix = getVectorMatrix(opts.db);
  const vecRanks = new Map<string, number>();
  if (matrix.ids.length > 0) {
    const [queryVec] = await opts.embedder.embed([opts.query]);
    if (queryVec) {
      topKCosine(matrix, queryVec, CANDIDATE_DEPTH).forEach((s, i) =>
        vecRanks.set(s.datasetId, i + 1),
      );
    }
  }

  const candidates = new Map<string, ScoredCandidate>();
  for (const id of ftsRanks.keys())
    candidates.set(id, { datasetId: id, ftsRank: ftsRanks.get(id) });
  for (const id of vecRanks.keys()) {
    const c = candidates.get(id) ?? { datasetId: id };
    c.vecRank = vecRanks.get(id);
    candidates.set(id, c);
  }

  const scored = [...candidates.values()].map((c) => {
    const ftsScore = c.ftsRank ? 1 / (RRF_K + c.ftsRank) : 0;
    const vecScore = c.vecRank ? 1 / (RRF_K + c.vecRank) : 0;
    let matchKind: IndexEntry['matchKind'] = 'hybrid';
    if (c.ftsRank && !c.vecRank) matchKind = 'keyword';
    else if (!c.ftsRank && c.vecRank) matchKind = 'semantic';
    return { datasetId: c.datasetId, score: ftsScore + vecScore, matchKind };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/** Bound repos once per call so both producers (`search`/`searchByEntity`) project identically. */
interface ProjectionCtx {
  sloSeconds: number;
  datasets: DatasetsRepo;
  orgs: OrganizationsRepo;
  translations: TranslationsRepo;
  artifacts: CuratedArtifactsRepo;
}

function projectionContext(opts: QueryOptions): ProjectionCtx {
  return {
    sloSeconds: opts.freshnessSloSeconds ?? 86400,
    datasets: new DatasetsRepo(opts.db),
    orgs: new OrganizationsRepo(opts.db),
    translations: new TranslationsRepo(opts.db),
    artifacts: new CuratedArtifactsRepo(opts.db),
  };
}

/**
 * Resolve one ranked/entity hit into a full `IndexEntry` — the single source of truth for the
 * `IndexEntry` contract (spec 050 FR-324). Every producer (hybrid `search`, entity `searchByEntity`,
 * and their MCP/chat consumers) resolves `title.en`/`translator`/`translationConfidence` and
 * `publisher` by the same rules, so an entity-sourced result renders the same EN title + publisher as
 * a hybrid result for the same dataset. Returns null for a dataset that no longer exists.
 */
function projectEntry(
  ctx: ProjectionCtx,
  datasetId: string,
  score: number,
  matchKind: IndexEntry['matchKind'],
): IndexEntry | null {
  const ds = ctx.datasets.get(datasetId);
  if (!ds) return null;
  const titleTx = ctx.translations.forSubject('dataset_title', datasetId)[0];
  const org = ds.publisher_id ? ctx.orgs.get(ds.publisher_id) : null;
  const orgTitleTx = org
    ? ctx.translations.forSubject('entity_label', `org:${org.id}`)[0]
    : undefined;
  return {
    datasetId,
    score,
    matchKind,
    title: {
      bg: ds.title_bg,
      en: titleTx?.text_en ?? null,
      translator: titleTx?.translator ?? null,
      translationConfidence: titleTx?.confidence ?? null,
    },
    snippet: null,
    publisher: org
      ? {
          id: org.id,
          title: {
            bg: org.title_bg,
            en: orgTitleTx?.text_en ?? null,
            translator: orgTitleTx?.translator ?? null,
            translationConfidence: orgTitleTx?.confidence ?? null,
          },
        }
      : null,
    sourceUrl: ds.source_url,
    curatedDatasetPath: resolveCuratedDatasetPath(ctx.artifacts.byDataset(datasetId), ds.id),
    freshness: {
      lastSyncedAt: ds.last_synced_at,
      sourceLastModified: ds.metadata_modified,
      sourceEtagOrHash: ds.source_etag_or_hash,
      isStale: (Date.now() - new Date(ds.last_synced_at).getTime()) / 1000 > ctx.sloSeconds,
      freshnessSloSeconds: ctx.sloSeconds,
    },
  };
}

export async function search(opts: QueryOptions): Promise<IndexEntry[]> {
  const ranked = await searchRanked(opts);
  const ctx = projectionContext(opts);
  const out: IndexEntry[] = [];
  for (const hit of ranked) {
    const entry = projectEntry(ctx, hit.datasetId, hit.score, hit.matchKind);
    if (entry) out.push(entry);
  }
  return out;
}

export async function searchByEntity(opts: QueryOptions, entityId: string): Promise<IndexEntry[]> {
  const limit = opts.limit ?? 50;
  const entities = new EntitiesRepo(opts.db);
  const datasetIds = entities.datasetsForEntity(entityId);
  const matchedEntity = entities.get(entityId);
  const matched = [
    {
      entityId,
      kind: matchedEntity?.kind ?? 'unknown',
      label: {
        bg: matchedEntity?.canonical_label_bg ?? '',
        en: matchedEntity?.canonical_label_en ?? null,
      },
    },
  ];
  const ctx = projectionContext(opts);
  const out: IndexEntry[] = [];
  for (const id of datasetIds.slice(0, limit)) {
    const entry = projectEntry(ctx, id, 1.0, 'entity');
    if (!entry) continue;
    entry.matchedEntities = matched;
    out.push(entry);
  }
  return out;
}
