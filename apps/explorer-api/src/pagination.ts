// Shared list-pagination helpers (spec 056 FR-392): one `clampInt` semantics for every paged
// endpoint (`/api/datasets`, `/api/me/sessions`, admin `/usage` `/tenants` `/api-usage`), so a list
// surface never returns an unbounded full-table dump. `limit` is clamped to `[0, maxLimit]` (default
// when absent/invalid); `offset` is clamped to `[0, MAX_SAFE_INTEGER]`.

/** Parse a query-string integer, clamping to `[0, max]` and falling back to `def` when absent/invalid. */
export function clampInt(raw: string | null, def: number, max: number): number {
  const n = raw === null ? def : Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return def;
  return Math.min(n, max);
}

export interface PageParams {
  limit: number;
  offset: number;
}

/** Resolve `limit`/`offset` from a query string with a per-endpoint default + hard cap. */
export function pageParams(q: URLSearchParams, defLimit: number, maxLimit: number): PageParams {
  return {
    limit: clampInt(q.get('limit'), defLimit, maxLimit),
    offset: clampInt(q.get('offset'), 0, Number.MAX_SAFE_INTEGER),
  };
}

/** Default page size + hard cap for the admin/self list endpoints (mirrors `/api/datasets`). */
export const LIST_DEFAULT_LIMIT = 100;
export const LIST_MAX_LIMIT = 200;
