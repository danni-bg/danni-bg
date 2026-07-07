import type { Database } from 'bun:sqlite';
import { nowIso } from '../../lib/time.ts';

interface SettingRow {
  tenant_id: string;
  key: string;
  value_json: string;
  updated_at: string;
  updated_by: string | null;
}

/** The deployment-wide settings row: applies to every tenant unless overridden. */
export const GLOBAL_SETTINGS = 'global';

/**
 * Extensible key/value platform settings (spec 019), now tenant-scoped (spec 029). Values are JSON;
 * callers validate per-key on read with a Zod schema (Constitution VII). A `global` row is the
 * deployment-wide default (the admin LLM/toggles config); a per-tenant row overrides it for that
 * tenant. Reads with no tenant (or for the global tenant) see the global row, so all existing call
 * sites keep their behavior. Used by the admin settings API and the chat's default provider resolution.
 */
export class PlatformSettingsRepo {
  constructor(private readonly db: Database) {}

  /**
   * Parsed JSON value for a key, or null if unset. With a `tenantId`, the tenant's own value wins; if
   * it has none, falls back to the `global` value. Without a tenant, returns the global value.
   */
  get(key: string, tenantId: string = GLOBAL_SETTINGS): unknown {
    if (tenantId !== GLOBAL_SETTINGS) {
      const own = this.row(tenantId, key);
      if (own) return JSON.parse(own.value_json);
    }
    const global = this.row(GLOBAL_SETTINGS, key);
    return global ? JSON.parse(global.value_json) : null;
  }

  /**
   * The tenant's OWN value for a key with NO global fallback — null when the tenant hasn't overridden
   * it. Distinguishes "overridden" from "inherited" and lets a caller merge a secret against the
   * tenant's own prior value only, never the global secret (spec 042 FR-243).
   */
  own(key: string, tenantId: string): unknown {
    const r = this.row(tenantId, key);
    return r ? JSON.parse(r.value_json) : null;
  }

  /** Remove a tenant's override for a key (it falls back to the global row thereafter, spec 042). */
  clear(key: string, tenantId: string): void {
    this.db
      .query('DELETE FROM platform_settings WHERE tenant_id = ? AND key = ?')
      .run(tenantId, key);
  }

  private row(tenantId: string, key: string): SettingRow | null {
    return this.db
      .query<SettingRow, [string, string]>(
        'SELECT * FROM platform_settings WHERE tenant_id = ? AND key = ?',
      )
      .get(tenantId, key);
  }

  set(
    key: string,
    value: unknown,
    updatedBy: string | null = null,
    now: string = nowIso(),
    tenantId: string = GLOBAL_SETTINGS,
  ): void {
    this.db
      .query(
        `INSERT INTO platform_settings (tenant_id, key, value_json, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .run(tenantId, key, JSON.stringify(value), now, updatedBy);
  }

  /** All settings for a tenant (global by default), key → parsed value. */
  all(tenantId: string = GLOBAL_SETTINGS): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const row of this.db
      .query<SettingRow, [string]>('SELECT * FROM platform_settings WHERE tenant_id = ?')
      .all(tenantId)) {
      out[row.key] = JSON.parse(row.value_json);
    }
    return out;
  }
}
