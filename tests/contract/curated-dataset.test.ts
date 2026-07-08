import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { datasetView } from '../../src/read/dataset-view.ts';
import { runMigrations } from '../../src/store/migrate.ts';
import { CuratedArtifactsRepo } from '../../src/store/repos/curated-artifacts.ts';
import { DatasetLinksRepo } from '../../src/store/repos/dataset-links.ts';
import { DatasetsRepo } from '../../src/store/repos/datasets.ts';
import { EntitiesRepo } from '../../src/store/repos/entities.ts';
import { OrganizationsRepo } from '../../src/store/repos/organizations.ts';
import { ResourcesRepo } from '../../src/store/repos/resources.ts';
import { TranslationsRepo } from '../../src/store/repos/translations.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MIGRATIONS = join(ROOT, 'migrations');

const LocalizedText = z
  .object({
    bg: z.string(),
    en: z.string().nullable().optional(),
    translator: z.string().nullable().optional(),
    translationConfidence: z.number().min(0).max(1).nullable().optional(),
  })
  .strict();

const Freshness = z
  .object({
    lastSyncedAt: z.string(),
    sourceLastModified: z.string().nullable().optional(),
    sourceEtagOrHash: z.string().nullable().optional(),
    isStale: z.boolean(),
    freshnessSloSeconds: z.number().int().min(0),
  })
  .strict();

const CuratedDatasetSchema = z.object({
  datasetId: z.string(),
  slug: z.string(),
  sourceUrl: z.string(),
  publisher: z
    .object({
      id: z.string(),
      slug: z.string(),
      title: LocalizedText,
      sourceUrl: z.string().optional(),
    })
    .strict()
    .nullable(),
  title: LocalizedText,
  description: LocalizedText,
  tags: z.array(z.string()).optional(),
  groups: z.array(z.string()).optional(),
  license: z.string().nullable().optional(),
  lifecycleState: z.enum(['active', 'withdrawn', 'out_of_scope']),
  withdrawnReason: z.string().nullable().optional(),
  freshness: Freshness,
  resources: z.array(z.unknown()),
  entities: z.array(z.unknown()),
  links: z.array(z.unknown()),
});

describe('contract.curated-dataset', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    runMigrations(db, MIGRATIONS);
  });
  afterEach(() => {
    db.close();
  });

  it('mirror-info composeView output validates against the schema', () => {
    new OrganizationsRepo(db).upsert({
      id: 'org-1',
      slug: 'sofia',
      titleBg: 'Столична община',
      sourceUrl: 'https://x/org-1',
    });
    new DatasetsRepo(db).upsert({
      id: 'd1',
      slug: 'budget',
      titleBg: 'Бюджет',
      descriptionBg: 'Описание',
      publisherId: 'org-1',
      tags: ['budget'],
      groups: ['finansi'],
      sourceUrl: 'https://x/d1',
    });
    new ResourcesRepo(db).upsert({
      id: 'r1',
      datasetId: 'd1',
      sourceUrl: 'https://x/r1.csv',
      declaredFormat: 'csv',
    });
    new CuratedArtifactsRepo(db).upsert({
      datasetId: 'd1',
      resourceId: 'r1',
      kind: 'tabular',
      path: 'd1/r1/data.ndjson',
      schemaJson: '{"kind":"tabular"}',
      transformRulesJson: '[]',
      curatorVersion: 'v1',
    });
    new TranslationsRepo(db).upsert({
      subjectKind: 'dataset_title',
      subjectId: 'd1',
      textBg: 'Бюджет',
      textEn: 'Budget',
      translator: 'local-marianmt:v1',
      confidence: 0.7,
    });
    const view = datasetView(db, 'd1', 86400);
    const r = CuratedDatasetSchema.safeParse(view);
    if (!r.success) throw new Error(JSON.stringify(r.error.issues));
    expect(r.success).toBe(true);
  });

  it('projects related-dataset links (both a-side and b-side)', () => {
    const ds = new DatasetsRepo(db);
    for (const id of ['d1', 'd0', 'd2']) {
      ds.upsert({
        id,
        slug: id,
        titleBg: `Набор ${id}`,
        descriptionBg: 'x',
        tags: [],
        groups: [],
        sourceUrl: `https://x/${id}`,
      });
    }
    const ents = new EntitiesRepo(db);
    ents.upsert({ id: 'geo:x', kind: 'geographic_unit', canonicalLabelBg: 'X' });
    ents.upsert({ id: 'geo:y', kind: 'geographic_unit', canonicalLabelBg: 'Y' });
    const links = new DatasetLinksRepo(db);
    // d1 vs d2 → d1 is the a-side (returns dataset_b_id); d1 vs d0 → d1 is the b-side (returns a_id).
    links.insert({
      datasetA: 'd1',
      datasetB: 'd2',
      viaEntityId: 'geo:x',
      heuristic: 'shared',
      confidence: 0.8,
    });
    links.insert({
      datasetA: 'd1',
      datasetB: 'd0',
      viaEntityId: 'geo:y',
      heuristic: 'shared',
      confidence: 0.6,
    });

    const view = datasetView(db, 'd1', 86400);
    const others = view.links.map((l) => l.otherDatasetId).sort();
    expect(others).toEqual(['d0', 'd2']);
    expect(view.links.every((l) => l.heuristic === 'shared')).toBe(true);
    expect(view.links.map((l) => l.viaEntityId).sort()).toEqual(['geo:x', 'geo:y']);
  });
});
