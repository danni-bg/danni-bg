import type { Database } from 'bun:sqlite';
import { DatasetsRepo } from '../store/repos/datasets.ts';
import { EntitiesRepo } from '../store/repos/entities.ts';
import { TranslationsRepo } from '../store/repos/translations.ts';

export function composeEmbeddingText(db: Database, datasetId: string): string {
  const ds = new DatasetsRepo(db).get(datasetId);
  if (!ds) return '';
  const tx = new TranslationsRepo(db);
  const titleEn = tx.forSubject('dataset_title', datasetId)[0]?.text_en ?? '';
  const descEn = tx.forSubject('dataset_description', datasetId)[0]?.text_en ?? '';
  const entityLabels = new EntitiesRepo(db)
    .entitiesForDataset(datasetId)
    .flatMap((e) => [e.canonical_label_bg, e.canonical_label_en ?? ''])
    .filter((s) => s.length > 0)
    .join(' ');
  return [ds.title_bg, titleEn, ds.description_bg ?? '', descEn, entityLabels]
    .filter((s) => s.length > 0)
    .join('\n');
}
