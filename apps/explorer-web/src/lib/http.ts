// The one HTTP convention for the SPA (spec 057, FR-400). Every typed API facade in `lib/*Api.ts`
// delegates here so URL building, JSON headers, cookie credentials, and non-OK → typed error live in
// exactly one place. This replaces ~15 hand-rolled `fetch → if (!res.ok) throw → res.json()` blocks.

export function buildUrl(path: string, params?: URLSearchParams): string {
  const qs = params?.toString();
  return qs ? `${path}?${qs}` : path;
}

/** A non-2xx HTTP response. Carries the status + path so callers can branch (401 vs 500) if needed. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
  ) {
    super(`request failed: ${status} ${path}`);
    this.name = 'HttpError';
  }
}

export interface RequestOptions {
  method?: string;
  /** JSON request body — serialized with a `content-type: application/json` header. */
  body?: unknown;
  params?: URLSearchParams;
  /** Send the session cookie (`credentials: 'include'`) for the authed `/api/me/*` + `/api/admin/*`. */
  authed?: boolean;
}

/**
 * Fetch `path`, throwing {@link HttpError} on a non-OK response. Returns the parsed JSON body, or
 * `undefined` for an empty body (204 / void endpoints like DELETE/reset). The single source of the
 * `credentials`/headers convention.
 */
export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, params, authed } = opts;
  const init: RequestInit = { method };
  if (authed) init.credentials = 'include';
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(buildUrl(path, params), init);
  if (!res.ok) throw new HttpError(res.status, path);
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}
