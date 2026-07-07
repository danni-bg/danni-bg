import type { Database } from 'bun:sqlite';
import { isStale } from '../lib/time.ts';
import { CuratedArtifactsRepo, type CuratedKind } from '../store/repos/curated-artifacts.ts';
import { DatasetLinksRepo } from '../store/repos/dataset-links.ts';
import { DatasetsRepo } from '../store/repos/datasets.ts';
import { EntitiesRepo } from '../store/repos/entities.ts';
import { OrganizationsRepo } from '../store/repos/organizations.ts';
import { ResourcesRepo } from '../store/repos/resources.ts';
import { TranslationsRepo } from '../store/repos/translations.ts';

/**
 * The machine-consumer-facing curated-dataset record (contracts/curated-dataset.schema.json):
 * datasets + organizations + curated_artifacts + dataset_entities + dataset_links + translations,
 * composed into one object. Original Bulgarian fields are present unmodified; English helpers are
 * clearly marked and never replace originals (Principle X, FR-019c). This is the read substrate the
 * `danni mirror-info` CLI and the `danni mcp` server both consume — never the other way around.
 */
export interface CuratedDatasetView {
  datasetId: string;
  slug: string;
  sourceUrl: string;
  publisher: { id: string; slug: string; title: { bg: string } } | null;
  title: {
    bg: string;
    en: string | null;
    translator: string | null;
    translationConfidence: number | null;
  };
  description: {
    bg: string;
    en: string | null;
    translator: string | null;
    translationConfidence: number | null;
  };
  tags: string[];
  groups: string[];
  license: string | null;
  lifecycleState: string;
  withdrawnReason: string | null;
  freshness: {
    lastSyncedAt: string;
    sourceLastModified: string | null;
    sourceEtagOrHash: string | null;
    isStale: boolean;
    freshnessSloSeconds: number;
  };
  resources: Array<{
    resourceId: string;
    sourceUrl: string;
    name: string | null;
    kind: CuratedKind | null;
    rawPath: string | null;
    curatedPath: string | null;
    declaredFormat: string | null;
    detectedFormat: string | null;
    schema: unknown;
    transformRules: unknown[];
    freshness: {
      lastSyncedAt: string;
      sourceLastModified: string | null;
      sourceEtagOrHash: string | null;
      isStale: boolean;
      freshnessSloSeconds: number;
    };
  }>;
  entities: Array<{
    entityId: string;
    kind: string;
    label: { bg: string; en: string | null };
    extractor: string;
    confidence: number;
  }>;
  links: Array<{
    otherDatasetId: string;
    viaEntityId: string;
    heuristic: string;
    confidence: number;
  }>;
}

/** Compose the full curated-dataset record for one dataset, or throw if it does not exist. */
export function datasetView(
  db: Database,
  datasetId: string,
  freshnessSloSeconds: number,
): CuratedDatasetView {
  const datasetsRepo = new DatasetsRepo(db);
  const resourcesRepo = new ResourcesRepo(db);
  const orgsRepo = new OrganizationsRepo(db);
  const artifactsRepo = new CuratedArtifactsRepo(db);
  const entitiesRepo = new EntitiesRepo(db);
  const linksRepo = new DatasetLinksRepo(db);
  const translationsRepo = new TranslationsRepo(db);

  const dataset = datasetsRepo.get(datasetId);
  if (!dataset) throw new Error(`dataset ${datasetId} not found`);
  const titleTx = translationsRepo.forSubject('dataset_title', datasetId)[0];
  const descTx = translationsRepo.forSubject('dataset_description', datasetId)[0];
  const org = dataset.publisher_id ? orgsRepo.get(dataset.publisher_id) : null;
  const artifacts = artifactsRepo.byDataset(datasetId);
  const resources = resourcesRepo.listByDataset(datasetId);

  return {
    datasetId: dataset.id,
    slug: dataset.slug,
    sourceUrl: dataset.source_url,
    publisher: org ? { id: org.id, slug: org.slug, title: { bg: org.title_bg } } : null,
    title: {
      bg: dataset.title_bg,
      en: titleTx?.text_en ?? null,
      translator: titleTx?.translator ?? null,
      translationConfidence: titleTx?.confidence ?? null,
    },
    description: {
      bg: dataset.description_bg ?? '',
      en: descTx?.text_en ?? null,
      translator: descTx?.translator ?? null,
      translationConfidence: descTx?.confidence ?? null,
    },
    tags: JSON.parse(dataset.tags_json) as string[],
    groups: JSON.parse(dataset.groups_json) as string[],
    license: dataset.license_id,
    lifecycleState: dataset.lifecycle_state,
    withdrawnReason: dataset.withdrawn_reason,
    freshness: {
      lastSyncedAt: dataset.last_synced_at,
      sourceLastModified: dataset.metadata_modified,
      sourceEtagOrHash: dataset.source_etag_or_hash,
      isStale: isStale(dataset.last_synced_at, freshnessSloSeconds),
      freshnessSloSeconds,
    },
    resources: resources.map((r) => {
      const artifact = artifacts.find((a) => a.resource_id === r.id);
      return {
        resourceId: r.id,
        sourceUrl: r.source_url,
        name: r.name,
        kind: artifact?.kind ?? null,
        rawPath: r.raw_path,
        curatedPath: artifact?.path ?? null,
        declaredFormat: r.declared_format,
        detectedFormat: r.detected_format,
        schema: artifact ? JSON.parse(artifact.schema_json) : null,
        transformRules: artifact ? (JSON.parse(artifact.transform_rules_json) as unknown[]) : [],
        freshness: {
          lastSyncedAt: r.last_synced_at,
          sourceLastModified: r.last_modified,
          sourceEtagOrHash: r.etag,
          isStale: isStale(r.last_synced_at, freshnessSloSeconds),
          freshnessSloSeconds,
        },
      };
    }),
    entities: entitiesRepo.listAttachments(datasetId).map((att) => {
      const ent = entitiesRepo.get(att.entity_id);
      return {
        entityId: att.entity_id,
        kind: ent?.kind ?? 'tag',
        label: { bg: ent?.canonical_label_bg ?? '', en: ent?.canonical_label_en ?? null },
        extractor: att.extractor,
        confidence: att.confidence,
      };
    }),
    links: linksRepo.forDataset(datasetId).map((l) => ({
      otherDatasetId: l.dataset_a_id === datasetId ? l.dataset_b_id : l.dataset_a_id,
      viaEntityId: l.via_entity_id,
      heuristic: l.heuristic,
      confidence: l.confidence,
    })),
  };
}
