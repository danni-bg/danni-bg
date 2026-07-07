// Adapts the in-process read API (src/read + src/index/query.ts) to the explorer's view-model
// shapes (T009). The pure projection functions (viewToPointer / viewToDetail / geoEntityIdsOf) hold
// all the reshaping logic and are unit-tested without a DB; ReadBridge binds them to a live store.

import type { Database } from 'bun:sqlite';
import { ENTITY_PREDICATES } from '../../../src/enrich/relations/vocabulary.ts';
import type { Embedder } from '../../../src/index/embedder.ts';
import type { IndexEntry, RankedHit } from '../../../src/index/query.ts';
import { search, searchByEntity, searchRanked } from '../../../src/index/query.ts';
import { isStale } from '../../../src/lib/time.ts';
import type { CuratedDatasetView } from '../../../src/read/dataset-view.ts';
import { datasetView } from '../../../src/read/dataset-view.ts';
import type { GridQuery } from '../../../src/read/resource-grid.ts';
import { type ResourceContent, readResourceRows } from '../../../src/read/resource-rows.ts';
import { DatasetsRepo } from '../../../src/store/repos/datasets.ts';
import { EntitiesRepo, type EntityRow } from '../../../src/store/repos/entities.ts';
import { EntityRelationsRepo } from '../../../src/store/repos/entity-relations.ts';
import type { DatasetLite } from './dataset-lite.ts';
import type {
  DatasetDetailView,
  DatasetPointer,
  EntityGraphView,
  EntityNode,
  FreshnessFilter,
} from './schemas.ts';

/** Geographic entity ids attached to a dataset view (entity ids are namespaced `geo:`). */
export function geoEntityIdsOf(view: CuratedDatasetView): string[] {
  return view.entities.filter((e) => e.entityId.startsWith('geo:')).map((e) => e.entityId);
}

/** Highest geo-link confidence among a view's geo entities (0 when none). */
export function maxGeoConfidence(view: CuratedDatasetView): number {
  const cs = view.entities.filter((e) => e.entityId.startsWith('geo:')).map((e) => e.confidence);
  return cs.length > 0 ? Math.max(...cs) : 0;
}

export function viewToPointer(
  view: CuratedDatasetView,
  score: number | null = null,
): DatasetPointer {
  return {
    datasetId: view.datasetId,
    titleBg: view.title.bg,
    titleEn: view.title.en,
    translationConfidence: view.title.translationConfidence,
    publisher: view.publisher ? { id: view.publisher.id, titleBg: view.publisher.title.bg } : null,
    tags: view.tags,
    freshness: view.freshness,
    geoEntityIds: geoEntityIdsOf(view),
    sourceUrl: view.sourceUrl,
    score,
  };
}

export function viewToDetail(view: CuratedDatasetView): DatasetDetailView {
  return {
    datasetId: view.datasetId,
    titleBg: view.title.bg,
    titleEn: view.title.en,
    descriptionBg: view.description.bg,
    descriptionEn: view.description.en,
    translationConfidence: view.title.translationConfidence,
    publisher: view.publisher ? { id: view.publisher.id, titleBg: view.publisher.title.bg } : null,
    tags: view.tags,
    lifecycleState: view.lifecycleState,
    withdrawnReason: view.withdrawnReason,
    freshness: view.freshness,
    geoEntityIds: geoEntityIdsOf(view),
    resources: view.resources.map((r) => ({
      resourceId: r.resourceId,
      name: r.name,
      kind: r.kind,
      schema: r.schema,
      freshness: r.freshness,
    })),
    entities: view.entities.map((e) => ({
      entityId: e.entityId,
      kind: e.kind,
      labelBg: e.label.bg,
      labelEn: e.label.en,
      confidence: e.confidence,
    })),
    links: view.links.map((l) => ({
      otherDatasetId: l.otherDatasetId,
      viaEntityId: l.viaEntityId,
      confidence: l.confidence,
    })),
    sourceUrl: view.sourceUrl,
  };
}

/** True when a dataset's freshness matches a freshness filter. */
export function matchesFreshness(isStale: boolean, filter: FreshnessFilter): boolean {
  if (filter === 'any') return true;
  return filter === 'stale' ? isStale : !isStale;
}

export interface ReadBridgeDeps {
  db: Database;
  storeRoot: string;
  embedder: Embedder;
  freshnessSloSeconds: number;
}

/** Live binding of the projection logic to a store handle. */
export class ReadBridge {
  constructor(private readonly deps: ReadBridgeDeps) {}

  view(datasetId: string): CuratedDatasetView {
    return datasetView(this.deps.db, datasetId, this.deps.freshnessSloSeconds);
  }

  detail(datasetId: string): DatasetDetailView {
    return viewToDetail(this.view(datasetId));
  }

  /**
   * One entity's node in the knowledge graph: its canonical labels, its outgoing/incoming
   * entity<->entity relations (e.g. a municipality's parent oblast, or an oblast's child
   * municipalities), and how many datasets link to it directly. Returns null for an unknown id.
   */
  entityGraph(entityId: string): EntityGraphView | null {
    const db = this.deps.db;
    const entities = new EntitiesRepo(db);
    const self = entities.get(entityId);
    if (!self) return null;
    const relations = new EntityRelationsRepo(db);
    const toNode = (r: EntityRow): EntityNode => ({
      entityId: r.id,
      kind: r.kind,
      labelBg: r.canonical_label_bg,
      labelEn: r.canonical_label_en,
    });
    const resolve = (id: string): EntityNode => {
      const e = entities.get(id);
      return e ? toNode(e) : { entityId: id, kind: 'unknown', labelBg: id, labelEn: null };
    };
    return {
      entity: toNode(self),
      out: relations.bySubject(entityId).map((r) => ({
        predicate: r.predicate,
        confidence: r.confidence,
        entity: resolve(r.object_id),
      })),
      in: relations.byObject(entityId).map((r) => ({
        predicate: r.predicate,
        confidence: r.confidence,
        entity: resolve(r.subject_id),
      })),
      datasetCount: entities.datasetsForEntity(entityId).length,
    };
  }

  /**
   * The administrative hierarchy as a `municipality entity id -> parent oblast entity id` map,
   * read from the `part_of` edges of the knowledge graph. Source of truth for the region roll-up
   * (replaces the gazetteer-crosswalk special-case). Empty until a curate pass materialises it.
   */
  partOfParents(): Map<string, string> {
    return new Map(
      new EntityRelationsRepo(this.deps.db)
        .byPredicate(ENTITY_PREDICATES.PART_OF)
        .map((r) => [r.subject_id, r.object_id]),
    );
  }

  /**
   * The inverse hierarchy: `parent oblast entity id -> child municipality entity ids`. Used to
   * expand an oblast geo filter to its municipalities so the filtered list matches the choropleth
   * roll-up (see geo-rollup.ts). Empty until a curate pass materialises the `part_of` edges.
   */
  partOfChildren(): Map<string, string[]> {
    const children = new Map<string, string[]>();
    for (const [child, parent] of this.partOfParents()) {
      const list = children.get(parent);
      if (list) list.push(child);
      else children.set(parent, [child]);
    }
    return children;
  }

  rows(
    datasetId: string,
    resourceId: string,
    limit?: number,
    offset?: number,
    grid?: GridQuery,
  ): ResourceContent {
    return readResourceRows(this.deps.db, this.deps.storeRoot, datasetId, resourceId, {
      ...(limit !== undefined ? { limit } : {}),
      ...(offset !== undefined ? { offset } : {}),
      ...(grid !== undefined ? { grid } : {}),
    });
  }

  listAllIds(): string[] {
    return new DatasetsRepo(this.deps.db).listAll().map((d) => d.id);
  }

  /**
   * Bulk catalog projection for the whole-catalog endpoints (list / regions / national / facets).
   * Four set-based queries + an in-memory join, instead of one full CuratedDatasetView per dataset:
   * O(catalog) point-queries collapsed to O(1) so the read path scales to the full ~11k-dataset
   * mirror without the per-request memory blow-up. Ordered by id for stable pagination.
   */
  listLite(): DatasetLite[] {
    const db = this.deps.db;
    const slo = this.deps.freshnessSloSeconds;
    // One timestamp for the whole batch so every row in a listLite() call is judged against the same
    // clock (FR-373); the shared helper takes it as an explicit `now`.
    const now = Date.now();

    const rows = db
      .query<
        {
          id: string;
          title_bg: string;
          publisher_id: string | null;
          tags_json: string;
          source_url: string;
          last_synced_at: string;
          metadata_modified: string | null;
          source_etag_or_hash: string | null;
          lifecycle_state: string;
        },
        []
      >(
        `SELECT id, title_bg, publisher_id, tags_json, source_url, last_synced_at,
                metadata_modified, source_etag_or_hash, lifecycle_state
         FROM datasets ORDER BY id`,
      )
      .all();

    const titleTx = new Map<string, { en: string; conf: number }>();
    for (const t of db
      .query<{ subject_id: string; text_en: string; confidence: number }, []>(
        "SELECT subject_id, text_en, confidence FROM translations WHERE subject_kind = 'dataset_title'",
      )
      .all()) {
      if (!titleTx.has(t.subject_id))
        titleTx.set(t.subject_id, { en: t.text_en, conf: t.confidence });
    }

    const orgTitle = new Map<string, string>();
    for (const o of db
      .query<{ id: string; title_bg: string }, []>('SELECT id, title_bg FROM organizations')
      .all()) {
      orgTitle.set(o.id, o.title_bg);
    }

    // Geo links only (entity ids namespaced `geo:`), de-duplicated to max confidence per entity.
    const geoByDataset = new Map<string, Map<string, number>>();
    for (const g of db
      .query<{ dataset_id: string; entity_id: string; confidence: number }, []>(
        "SELECT dataset_id, entity_id, confidence FROM dataset_entities WHERE substr(entity_id, 1, 4) = 'geo:'",
      )
      .all()) {
      let m = geoByDataset.get(g.dataset_id);
      if (!m) {
        m = new Map();
        geoByDataset.set(g.dataset_id, m);
      }
      const prev = m.get(g.entity_id);
      if (prev === undefined || g.confidence > prev) m.set(g.entity_id, g.confidence);
    }

    return rows.map((r) => {
      const tx = titleTx.get(r.id);
      const gm = geoByDataset.get(r.id);
      return {
        datasetId: r.id,
        titleBg: r.title_bg,
        titleEn: tx?.en ?? null,
        translationConfidence: tx?.conf ?? null,
        publisherId: r.publisher_id,
        publisherTitleBg: r.publisher_id ? (orgTitle.get(r.publisher_id) ?? null) : null,
        tags: JSON.parse(r.tags_json) as string[],
        lifecycleState: r.lifecycle_state,
        sourceUrl: r.source_url,
        freshness: {
          lastSyncedAt: r.last_synced_at,
          sourceLastModified: r.metadata_modified,
          sourceEtagOrHash: r.source_etag_or_hash,
          isStale: isStale(r.last_synced_at, slo, now),
          freshnessSloSeconds: slo,
        },
        geoLinks: gm
          ? [...gm.entries()]
              .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
              .map(([entityId, confidence]) => ({ entityId, confidence }))
          : [],
      };
    });
  }

  /**
   * Ranking-only hybrid search: fused (datasetId, score, matchKind) hits with no per-hit DB
   * projection (spec 050 FR-323). The explorer search route resolves these ids through the bulk
   * `listLite` projection, so a 200-hit query executes a bounded number of statements instead of a
   * per-hit `view()` fan-out.
   */
  searchRanked(query: string, limit?: number): Promise<RankedHit[]> {
    return searchRanked({
      db: this.deps.db,
      embedder: this.deps.embedder,
      query,
      freshnessSloSeconds: this.deps.freshnessSloSeconds,
      ...(limit !== undefined ? { limit } : {}),
    });
  }

  search(query: string, limit?: number): Promise<IndexEntry[]> {
    return search({
      db: this.deps.db,
      embedder: this.deps.embedder,
      query,
      freshnessSloSeconds: this.deps.freshnessSloSeconds,
      ...(limit !== undefined ? { limit } : {}),
    });
  }

  entityDatasets(entityId: string, limit?: number): Promise<IndexEntry[]> {
    return searchByEntity(
      {
        db: this.deps.db,
        embedder: this.deps.embedder,
        query: '',
        freshnessSloSeconds: this.deps.freshnessSloSeconds,
        ...(limit !== undefined ? { limit } : {}),
      },
      entityId,
    );
  }
}
