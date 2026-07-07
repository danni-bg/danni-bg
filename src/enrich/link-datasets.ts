import type { Database } from 'bun:sqlite';
import { withTransaction } from '../store/db.ts';
import type { DatasetLinksRepo } from '../store/repos/dataset-links.ts';
import type { EntitiesRepo, EntityKind } from '../store/repos/entities.ts';

export interface LinkOptions {
  db: Database;
  entitiesRepo: EntitiesRepo;
  linksRepo: DatasetLinksRepo;
}

const HEURISTIC_BY_KIND: Record<EntityKind, string> = {
  organization: 'shared_publisher',
  geographic_unit: 'shared_geo',
  time_period: 'shared_time',
  named_subject: 'shared_subject',
  tag: 'shared_tag',
  group: 'shared_group',
};

const CONFIDENCE_BY_KIND: Record<EntityKind, number> = {
  organization: 0.95,
  geographic_unit: 0.9,
  time_period: 0.7,
  named_subject: 0.6,
  tag: 0.5,
  group: 0.7,
};

/**
 * Max datasets an entity may be shared by before it is treated as a generic "hub" and skipped.
 * Pairwise-linking is O(n²) per entity, so a handful of stop-word entities (the tags "регистър"
 * /"община", a whole oblast, a ministry publisher) produced ~99% of a 20M-link explosion on the full
 * mirror — links that carry no real "these two datasets are related" signal. Above this fan-out we
 * skip the entity entirely; specific/rare shared entities (the meaningful relations) still link.
 */
export const MAX_ENTITY_FANOUT = 50;

export interface LinkResult {
  created: number;
  /** Number of entities skipped because their fan-out exceeded MAX_ENTITY_FANOUT. */
  skippedHubs: number;
}

export function linkDatasetsForEntity(opts: LinkOptions, entityId: string): LinkResult {
  const ent = opts.entitiesRepo.get(entityId);
  if (!ent) return { created: 0, skippedHubs: 0 };
  const datasets = opts.entitiesRepo.datasetsForEntity(entityId);
  if (datasets.length > MAX_ENTITY_FANOUT) return { created: 0, skippedHubs: 1 };
  let created = 0;
  // One entity's up-to-~1.2k pairwise links are one logical unit: write them in a SINGLE transaction
  // (spec 052 FR-341) — per-entity atomicity plus one WAL commit/fsync instead of one per link (the
  // old ~10^5-fsync cost across a full-mirror run). `linkAllSharedEntities` stays a loop of these.
  withTransaction(opts.db, () => {
    for (let i = 0; i < datasets.length; i++) {
      for (let j = i + 1; j < datasets.length; j++) {
        const a = datasets[i];
        const b = datasets[j];
        if (typeof a !== 'string' || typeof b !== 'string') continue;
        opts.linksRepo.insert({
          datasetA: a,
          datasetB: b,
          viaEntityId: entityId,
          heuristic: HEURISTIC_BY_KIND[ent.kind],
          confidence: CONFIDENCE_BY_KIND[ent.kind],
        });
        created++;
      }
    }
  });
  return { created, skippedHubs: 0 };
}

export function linkAllSharedEntities(opts: LinkOptions, entityIds: string[]): LinkResult {
  let created = 0;
  let skippedHubs = 0;
  for (const id of entityIds) {
    const r = linkDatasetsForEntity(opts, id);
    created += r.created;
    skippedHubs += r.skippedHubs;
  }
  return { created, skippedHubs };
}
