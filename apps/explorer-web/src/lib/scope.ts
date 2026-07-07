// Pure encoders that turn the shared FilterState into (a) HTTP query params for the data endpoints
// and (b) a ScopeDescriptor sent with each chat request (T018/T035/T058). An empty FilterState
// encodes to an empty scope = full mirror.

import type { FilterState, ScopeDescriptor } from '../types.ts';

/** FilterState → URLSearchParams for /api/datasets, /api/regions, /api/facets. */
export function filterStateToParams(f: FilterState): URLSearchParams {
  const p = new URLSearchParams();
  for (const t of f.tags) p.append('tags', t);
  for (const id of f.publisherIds) p.append('publisherIds', id);
  for (const id of f.geoUnitIds) p.append('geoUnitIds', id);
  if (f.freshness !== 'any') p.set('freshness', f.freshness);
  if (f.query.trim() !== '') p.set('q', f.query.trim());
  if (f.includeWithdrawn) p.set('includeWithdrawn', 'true');
  return p;
}

/** FilterState → ScopeDescriptor (only non-default fields; `query` carried as soft context). */
export function filterStateToScope(f: FilterState): ScopeDescriptor {
  const scope: ScopeDescriptor = {};
  if (f.tags.length > 0) scope.tags = f.tags;
  if (f.publisherIds.length > 0) scope.publisherIds = f.publisherIds;
  if (f.geoUnitIds.length > 0) scope.geoUnitIds = f.geoUnitIds;
  if (f.freshness !== 'any') scope.freshness = f.freshness;
  if (f.includeWithdrawn) scope.includeWithdrawn = true;
  if (f.query.trim() !== '') scope.query = f.query.trim();
  return scope;
}
