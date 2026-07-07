import type { PortalConfig, ScopeConfig } from '../config/schema.ts';
import { DanniError } from '../lib/errors.ts';

export type PortalApi = PortalConfig['api'];

export interface DatasetSummary {
  id: string;
  slug?: string | undefined;
  publisherId?: string | undefined;
  groups?: string[] | undefined;
  tags?: string[] | undefined;
}

export type ScopePredicate = (d: DatasetSummary) => boolean;

function isEmpty(filter: ScopeConfig): boolean {
  return (
    !(filter.publishers && filter.publishers.length > 0) &&
    !(filter.categories && filter.categories.length > 0) &&
    !(filter.tags && filter.tags.length > 0) &&
    !(filter.datasetIds && filter.datasetIds.length > 0)
  );
}

export function buildScopePredicate(filter: ScopeConfig): ScopePredicate {
  if (isEmpty(filter)) return () => true;

  const publishers = new Set(filter.publishers ?? []);
  const categories = new Set(filter.categories ?? []);
  const tags = new Set(filter.tags ?? []);
  const datasetIds = new Set(filter.datasetIds ?? []);

  return (d: DatasetSummary): boolean => {
    if (datasetIds.size > 0 && (datasetIds.has(d.id) || (d.slug && datasetIds.has(d.slug)))) {
      return true;
    }
    if (publishers.size > 0 && d.publisherId && publishers.has(d.publisherId)) return true;
    if (categories.size > 0 && d.groups?.some((g) => categories.has(g))) return true;
    if (tags.size > 0 && d.tags?.some((t) => tags.has(t))) return true;
    return false;
  };
}

/**
 * Scope fields no adapter of a given portal api can express (spec 048, FR-302). Honoring `scope`
 * must mean the same thing on every adapter: a field the adapter cannot filter on is refused
 * loudly, never silently dropped (which would crawl a superset). data.egov.bg has no queryable
 * group/category taxonomy — getDatasetDetails carries only a numeric `category_id`, and egov-sync
 * always writes `groups: []` — so a `categories` scope cannot be honored there. CKAN expresses all
 * four fields, so its list is empty.
 */
const UNSUPPORTED_SCOPE_FIELDS: Record<PortalApi, (keyof ScopeConfig)[]> = {
  ckan: [],
  'egov-bg': ['categories'],
};

/** Raised when a `scope` field cannot be expressed by the selected portal adapter (FR-302). */
export class UnsupportedScopeFieldError extends DanniError {
  override readonly name: string = 'UnsupportedScopeFieldError';
  constructor(field: keyof ScopeConfig, api: PortalApi) {
    super(
      'UNSUPPORTED_SCOPE_FIELD',
      `scope.${field} is not supported by the ${api} portal adapter — remove it or switch portals (it cannot be honored, and silently crawling a superset is prohibited)`,
      { field, api },
    );
  }
}

/**
 * Fail loudly at sync start when the scope names a field the adapter cannot express (FR-302).
 * Called before any enumeration/capture so an unsupported scope aborts before touching the portal.
 */
export function assertScopeSupported(filter: ScopeConfig, api: PortalApi): void {
  for (const field of UNSUPPORTED_SCOPE_FIELDS[api]) {
    const values = filter[field];
    if (Array.isArray(values) && values.length > 0) {
      throw new UnsupportedScopeFieldError(field, api);
    }
  }
}

/**
 * egov publisher identity for a numeric `org_id` — the documented form for `scope.publishers` on
 * the egov adapter, matching the `organizations` row id, `run-egov-sync`'s `resolveOrg`, and the
 * `publisherId` fed to `buildScopePredicate`. A null/absent org id has no publisher identity.
 */
export function egovPublisherId(orgId: number | null | undefined): string | undefined {
  return orgId === null || orgId === undefined ? undefined : `egov-org-${orgId}`;
}

/**
 * egov enumeration filter (FR-300/303): decide from a `listDatasets` summary — which carries only
 * `org_id`, not tags — whether a dataset may belong to a scoped campaign, so a publisher scope
 * freezes only that publisher's uris (never the whole portal). Publisher scope is matched on the
 * egov publisher identity `egov-org-<org_id>`. Tags are absent from the summary, so a tag scope
 * keeps every dataset as a CANDIDATE here; the exact per-dataset decision is `buildScopePredicate`
 * over the full `getDatasetDetails` at processing time (FR-301). An unscoped filter matches all.
 */
export function egovSummaryInScope(
  summary: { org_id?: number | null | undefined },
  filter: ScopeConfig,
): boolean {
  const hasPublishers = (filter.publishers?.length ?? 0) > 0;
  const hasTags = (filter.tags?.length ?? 0) > 0;
  const hasDatasetIds = (filter.datasetIds?.length ?? 0) > 0;
  if (!hasPublishers && !hasTags && !hasDatasetIds) return true;
  // datasetIds/tags cannot be resolved from a summary → keep as candidates for the processing-time
  // check (a union scope stays correct: a publisher-miss may still match on tag/id at details).
  if (hasTags || hasDatasetIds) return true;
  const publisherId = egovPublisherId(summary.org_id);
  return publisherId !== undefined && (filter.publishers ?? []).includes(publisherId);
}

export function summarizeScope(filter: ScopeConfig): string {
  if (isEmpty(filter)) return 'all';
  const parts: string[] = [];
  if (filter.publishers?.length) parts.push(`publishers=${filter.publishers.length}`);
  if (filter.categories?.length) parts.push(`categories=${filter.categories.length}`);
  if (filter.tags?.length) parts.push(`tags=${filter.tags.length}`);
  if (filter.datasetIds?.length) parts.push(`datasetIds=${filter.datasetIds.length}`);
  return parts.join(',');
}
