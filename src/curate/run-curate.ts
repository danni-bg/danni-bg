import type { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BgAdminGazetteerExtractor } from '../enrich/extractors/bg-admin-gazetteer.ts';
import { BgAdminPublisherExtractor } from '../enrich/extractors/bg-admin-publisher.ts';
import { BgMonthDatesExtractor } from '../enrich/extractors/bg-month-dates.ts';
import { CkanGroupsExtractor } from '../enrich/extractors/ckan-groups.ts';
import { CkanOrganizationExtractor } from '../enrich/extractors/ckan-organization.ts';
import { CkanTagsExtractor } from '../enrich/extractors/ckan-tags.ts';
import { ColumnNameHeuristicsExtractor } from '../enrich/extractors/column-name-heuristics.ts';
import { Iso8601DatesExtractor } from '../enrich/extractors/iso8601-dates.ts';
import { linkAllSharedEntities } from '../enrich/link-datasets.ts';
import { registerEntities } from '../enrich/register-entities.ts';
import { registerEntityRelations } from '../enrich/relations/register-relations.ts';
import { translateSubjects } from '../enrich/translate.ts';
import type { Translator } from '../enrich/translator.ts';
import { withContext } from '../logging/logger.ts';
import { CuratedArtifactsRepo } from '../store/repos/curated-artifacts.ts';
import { DatasetLinksRepo } from '../store/repos/dataset-links.ts';
import { DatasetsRepo } from '../store/repos/datasets.ts';
import { EntitiesRepo } from '../store/repos/entities.ts';
import { EntityRelationsRepo } from '../store/repos/entity-relations.ts';
import { OrganizationsRepo } from '../store/repos/organizations.ts';
import { ResourcesRepo } from '../store/repos/resources.ts';
import { TranslationsRepo } from '../store/repos/translations.ts';
import { CuratorRegistry } from './registry.ts';

export interface RunCurateOptions {
  db: Database;
  storeRoot: string;
  curatorVersion: string;
  datasetIds?: string[];
  since?: string;
  translator?: Translator;
  /**
   * Re-run only entity extraction + cross-dataset linking, skipping resource parsing and
   * translation. Extraction reads dataset/resource METADATA rows (not the parsed artifacts), so
   * this is the cheap, low-memory way to refresh entities after an extractor/gazetteer change —
   * a full re-curate re-parses every captured file and can exhaust memory on a large mirror.
   */
  entitiesOnly?: boolean;
}

export interface RunCurateResult {
  curated: number;
  uncurated: number;
  entitiesAttached: number;
  linksCreated: number;
  translationsWritten: number;
  /** Subjects skipped because their (subject, translator, source text) was unchanged (FR-330). */
  translationsSkipped: number;
  /** Subjects with empty source text — no translation attempted (FR-333). */
  translationsEmpty: number;
  /** Entity<->entity relations (e.g. municipality part_of oblast) asserted into the graph. */
  relationsCreated: number;
}

export async function runCurate(opts: RunCurateOptions): Promise<RunCurateResult> {
  const log = withContext({ component: 'curate' });
  const datasetsRepo = new DatasetsRepo(opts.db);
  const resourcesRepo = new ResourcesRepo(opts.db);
  const orgsRepo = new OrganizationsRepo(opts.db);
  const artifactsRepo = new CuratedArtifactsRepo(opts.db);
  const entitiesRepo = new EntitiesRepo(opts.db);
  const relationsRepo = new EntityRelationsRepo(opts.db);
  const linksRepo = new DatasetLinksRepo(opts.db);
  const translationsRepo = new TranslationsRepo(opts.db);
  const registry = new CuratorRegistry();
  const extractors = [
    new CkanOrganizationExtractor(orgsRepo),
    new CkanGroupsExtractor(),
    new CkanTagsExtractor(),
    // Publisher-derived place (weaker signal, lower confidence) alongside in-content place. When a
    // dataset matches both, dataset_entities keeps a row per extractor (PK includes the extractor),
    // and the read layer takes the max confidence per (dataset, entity) — so the stronger in-content
    // 0.95/0.75 wins downstream over this extractor's 0.7/0.6.
    new BgAdminPublisherExtractor(orgsRepo),
    new BgAdminGazetteerExtractor(),
    new Iso8601DatesExtractor(),
    new BgMonthDatesExtractor(),
    new ColumnNameHeuristicsExtractor(),
  ];

  const allDatasets = datasetsRepo.listActive();
  const targets = allDatasets.filter((d) => {
    if (opts.datasetIds && opts.datasetIds.length > 0 && !opts.datasetIds.includes(d.id))
      return false;
    if (opts.since && d.last_synced_at < opts.since) return false;
    return true;
  });

  let curated = 0;
  let uncurated = 0;
  let entitiesAttached = 0;
  const touchedEntityIds = new Set<string>();
  let translationsWritten = 0;
  let translationsSkipped = 0;
  let translationsEmpty = 0;

  // Stub short-circuit (FR-332): a no-op translator can only write empty rows, so
  // skip the whole stage once rather than looping the catalog. Configuring a
  // hosted-api translator (or a stub `translateFn` override) re-enables it.
  const translationActive = !!opts.translator && !opts.entitiesOnly && !opts.translator.noop;
  if (opts.translator && !opts.entitiesOnly && opts.translator.noop) {
    log.info('curate.translate-skipped-stub', { translator: opts.translator.id });
  }

  for (const dataset of targets) {
    const resources = resourcesRepo.listByDataset(dataset.id);
    for (const r of resources) {
      if (opts.entitiesOnly) break; // entities-only: don't re-parse captured files
      // Skip resources without a successful capture — a prior raw_path may be
      // stale (upstream withdrawn/emptied on re-sync) and must not be re-curated.
      if (!r.raw_path || r.last_outcome !== 'success') continue;
      const rawAbs = join(opts.storeRoot, 'raw', r.raw_path);
      if (!existsSync(rawAbs)) {
        log.warn('curate.skip-missing-raw', { datasetId: dataset.id, resourceId: r.id });
        continue;
      }
      try {
        const out = await registry.curate({
          storeRoot: opts.storeRoot,
          resource: r,
          rawAbsPath: rawAbs,
          curatorVersion: opts.curatorVersion,
        });
        artifactsRepo.upsert({
          datasetId: dataset.id,
          resourceId: r.id,
          kind: out.kind,
          path: out.path,
          schemaJson: JSON.stringify(out.schema),
          transformRulesJson: JSON.stringify(out.transformRules),
          uncuratedReason: out.uncuratedReason ?? null,
          curatorVersion: opts.curatorVersion,
        });
        if (out.kind === 'uncurated') uncurated++;
        else curated++;
      } catch (err) {
        log.warn('curate.failed', {
          datasetId: dataset.id,
          resourceId: r.id,
          error: err instanceof Error ? err.message : String(err),
        });
        artifactsRepo.upsert({
          datasetId: dataset.id,
          resourceId: r.id,
          kind: 'uncurated',
          path: '',
          schemaJson: JSON.stringify({ kind: 'uncurated' }),
          transformRulesJson: '[]',
          uncuratedReason: err instanceof Error ? err.message : String(err),
          curatorVersion: opts.curatorVersion,
        });
        uncurated++;
      }
    }

    const result = await registerEntities(
      { db: opts.db, repo: entitiesRepo, extractors },
      { dataset, resources },
    );
    entitiesAttached += result.attached;
    for (const c of result.candidates) touchedEntityIds.add(c.candidate.id);

    if (translationActive && opts.translator) {
      const subjects = [
        { subjectKind: 'dataset_title' as const, subjectId: dataset.id, textBg: dataset.title_bg },
        ...(dataset.description_bg
          ? [
              {
                subjectKind: 'dataset_description' as const,
                subjectId: dataset.id,
                textBg: dataset.description_bg,
              },
            ]
          : []),
      ];
      const tx = await translateSubjects(
        { translator: opts.translator, repo: translationsRepo },
        subjects,
      );
      translationsWritten += tx.count;
      translationsSkipped += tx.skipped;
      translationsEmpty += tx.empty;
    }
  }

  const linkResult = linkAllSharedEntities(
    { db: opts.db, entitiesRepo, linksRepo },
    Array.from(touchedEntityIds),
  );

  // Materialise the entity<->entity relation graph (part_of hierarchy) from the gazetteer over the
  // entities now present. Global + idempotent, so it reconciles regardless of which datasets ran.
  const relationResult = registerEntityRelations({ entitiesRepo, relationsRepo });

  log.info('curate.completed', {
    curated,
    uncurated,
    entitiesAttached,
    linksCreated: linkResult.created,
    linksSkippedHubs: linkResult.skippedHubs,
    relationsCreated: relationResult.created,
    translationsWritten,
    translationsSkipped,
    translationsEmpty,
  });

  return {
    curated,
    uncurated,
    entitiesAttached,
    linksCreated: linkResult.created,
    translationsWritten,
    translationsSkipped,
    translationsEmpty,
    relationsCreated: relationResult.created,
  };
}
