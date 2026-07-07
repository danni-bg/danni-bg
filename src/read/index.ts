// Stable, in-process read API over the curated mirror — the single substrate the `mirror-info`
// CLI and the `danni mcp` read server consume. Read-only; the store on disk is the source of truth.
export { type CuratedDatasetView, datasetView } from './dataset-view.ts';
export {
  type ReadResourceOptions,
  type ResourceContent,
  readResourceRows,
} from './resource-rows.ts';
export { type IndexEntry, type QueryOptions, search, searchByEntity } from '../index/query.ts';
