// Typed fetch client over the explorer API (T018). A thin, typed facade over the shared `request`
// helper (spec 057, FR-400) — URL building + non-OK → typed error live in `lib/http.ts`, not here.
// Large result sets are paginated via limit/offset (FR-030).

// The GET /api/datasets/:id response shape is single-sourced from the API (spec 059 FR-422).
import type { DatasetDetailView } from '../../../explorer-api/src/schemas.ts';
import type {
  DatasetPointer,
  Facets,
  FilterState,
  RegionSummary,
  ResourceContent,
} from '../types.ts';
import type { GridSort } from './grid.ts';
import { buildUrl, request } from './http.ts';
import { filterStateToParams } from './scope.ts';

// `buildUrl` now lives in `lib/http.ts`; re-exported here for the existing import sites + tests.
export { buildUrl };

export interface GridQuery {
  sort: GridSort | null;
  filters: Record<string, string>;
}

export interface DatasetsResponse {
  datasets: DatasetPointer[];
  total: number;
  limit: number;
  offset: number;
}

export interface RegionDatasetsResponse {
  region: RegionSummary;
  datasets: DatasetPointer[];
  total: number;
}

export function fetchRegions(
  f: FilterState,
  level: 'oblast' | 'municipality',
): Promise<{ regions: RegionSummary[] }> {
  const params = filterStateToParams(f);
  params.set('level', level);
  return request('/api/regions', { params });
}

export function fetchDatasets(f: FilterState, limit = 50, offset = 0): Promise<DatasetsResponse> {
  const params = filterStateToParams(f);
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  return request('/api/datasets', { params });
}

export function fetchDataset(datasetId: string): Promise<DatasetDetailView> {
  return request(`/api/datasets/${encodeURIComponent(datasetId)}`);
}

export function fetchRegion(entityId: string, f: FilterState): Promise<RegionDatasetsResponse> {
  return request(`/api/regions/${encodeURIComponent(entityId)}`, {
    params: filterStateToParams(f),
  });
}

export function fetchFacets(f: FilterState): Promise<Facets> {
  return request('/api/facets', { params: filterStateToParams(f) });
}

/** Paginated/sampled rows (or document/text) of one resource — the data drilldown (FR-005/030). */
export function fetchResourceRows(
  datasetId: string,
  resourceId: string,
  limit = 50,
  offset = 0,
  grid?: GridQuery,
): Promise<ResourceContent> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (grid?.sort) {
    params.set('sort', grid.sort.col);
    params.set('dir', grid.sort.dir);
  }
  if (grid?.filters) {
    const active = Object.fromEntries(
      Object.entries(grid.filters).filter(([, v]) => v.trim() !== ''),
    );
    if (Object.keys(active).length > 0) params.set('filters', JSON.stringify(active));
  }
  return request(
    `/api/datasets/${encodeURIComponent(datasetId)}/resources/${encodeURIComponent(resourceId)}/rows`,
    { params },
  );
}

/** Non-georeferenced (national) datasets — those with no geographic entity (FR-006). */
export function fetchNational(f: FilterState, limit = 50, offset = 0): Promise<DatasetsResponse> {
  const params = filterStateToParams(f);
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  return request('/api/national', { params });
}
