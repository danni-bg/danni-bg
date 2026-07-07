import type { Database } from 'bun:sqlite';
import { nowIso } from '../../lib/time.ts';
import { DEFAULT_TENANT_ID } from './tenants.ts';

// Per-request API usage (spec 028). One row per metered request; counts over a time window drive the
// request quota + the usage views. Mirrors the other repos: a plain class over the shared Database.

export type RouteClass = 'data' | 'chat';
export type PrincipalKind = 'user' | 'apiKey';

export interface ApiUsageInput {
  principalKind: PrincipalKind;
  principalId: string; // owning users.id
  tenantId?: string; // owning org (spec 029); defaults to the default tenant
  keyId?: string | null; // api_keys.id when principalKind === 'apiKey'
  routeClass: RouteClass;
  now?: string;
}

export interface ApiUsageSummary {
  total: number;
  data: number;
  chat: number;
}

export class ApiUsageRepo {
  constructor(private readonly db: Database) {}

  /** Record one metered request. Best-effort: the caller wraps this so a write hiccup can't 500. */
  record(input: ApiUsageInput): void {
    this.db
      .query(
        'INSERT INTO api_usage (id, principal_kind, principal_id, tenant_id, key_id, route_class, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        crypto.randomUUID(),
        input.principalKind,
        input.principalId,
        input.tenantId ?? DEFAULT_TENANT_ID,
        input.keyId ?? null,
        input.routeClass,
        input.now ?? nowIso(),
      );
  }

  /** Requests by a principal since `sinceIso` (optionally one route class) — user-level rollup view. */
  countSince(principalId: string, sinceIso: string, routeClass?: RouteClass): number {
    const row = routeClass
      ? this.db
          .query<{ n: number }, [string, string, string]>(
            'SELECT COUNT(*) AS n FROM api_usage WHERE principal_id = ? AND created_at >= ? AND route_class = ?',
          )
          .get(principalId, sinceIso, routeClass)
      : this.db
          .query<{ n: number }, [string, string]>(
            'SELECT COUNT(*) AS n FROM api_usage WHERE principal_id = ? AND created_at >= ?',
          )
          .get(principalId, sinceIso);
    return row?.n ?? 0;
  }

  /**
   * Requests attributed to a single API key since `sinceIso` (optionally one route class) — backs the
   * per-key request quota (spec 040 FR-220). The quota attribution unit is the key, so this filters by
   * `key_id`, matching the per-key `quota_limit` the gate caps against: a key is throttled by its own
   * traffic only, never its owner's other keys.
   */
  countSinceForKey(keyId: string, sinceIso: string, routeClass?: RouteClass): number {
    const row = routeClass
      ? this.db
          .query<{ n: number }, [string, string, string]>(
            'SELECT COUNT(*) AS n FROM api_usage WHERE key_id = ? AND created_at >= ? AND route_class = ?',
          )
          .get(keyId, sinceIso, routeClass)
      : this.db
          .query<{ n: number }, [string, string]>(
            'SELECT COUNT(*) AS n FROM api_usage WHERE key_id = ? AND created_at >= ?',
          )
          .get(keyId, sinceIso);
    return row?.n ?? 0;
  }

  /** A user's own usage totals since `sinceIso`, plus a per-key breakdown (for /api/me/api-usage). */
  summaryForUser(
    userId: string,
    sinceIso: string,
  ): ApiUsageSummary & { byKey: { keyId: string; count: number }[] } {
    const base = this.summary(userId, sinceIso);
    const byKey = this.db
      .query<{ keyId: string; count: number }, [string, string]>(
        'SELECT key_id AS keyId, COUNT(*) AS count FROM api_usage WHERE principal_id = ? AND created_at >= ? AND key_id IS NOT NULL GROUP BY key_id',
      )
      .all(userId, sinceIso);
    return { ...base, byKey };
  }

  private summary(principalId: string, sinceIso: string): ApiUsageSummary {
    const rows = this.db
      .query<{ route_class: RouteClass; n: number }, [string, string]>(
        'SELECT route_class, COUNT(*) AS n FROM api_usage WHERE principal_id = ? AND created_at >= ? GROUP BY route_class',
      )
      .all(principalId, sinceIso);
    const data = rows.find((r) => r.route_class === 'data')?.n ?? 0;
    const chat = rows.find((r) => r.route_class === 'chat')?.n ?? 0;
    return { total: data + chat, data, chat };
  }

  /** Per-tenant totals since `sinceIso` — an org key's usage rolls up under its org (spec 029 SC-C3). */
  summaryByTenant(
    sinceIso: string,
  ): { tenantId: string; data: number; chat: number; total: number }[] {
    return this.db
      .query<{ tenantId: string; data: number; chat: number }, [string]>(
        `SELECT tenant_id AS tenantId,
                SUM(route_class = 'data') AS data,
                SUM(route_class = 'chat') AS chat
         FROM api_usage WHERE created_at >= ? GROUP BY tenant_id ORDER BY COUNT(*) DESC`,
      )
      .all(sinceIso)
      .map((r) => ({ ...r, total: r.data + r.chat }));
  }

  /** Per-principal totals since `sinceIso` (admin view), newest activity first. */
  summaryAll(sinceIso: string): { principalId: string; data: number; chat: number; total: number }[] {
    return this.db
      .query<{ principalId: string; data: number; chat: number }, [string]>(
        `SELECT principal_id AS principalId,
                SUM(route_class = 'data') AS data,
                SUM(route_class = 'chat') AS chat
         FROM api_usage WHERE created_at >= ? GROUP BY principal_id ORDER BY COUNT(*) DESC`,
      )
      .all(sinceIso)
      .map((r) => ({ ...r, total: r.data + r.chat }));
  }
}
