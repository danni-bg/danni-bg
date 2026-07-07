import type { Database } from 'bun:sqlite';
import { sha256Hex } from '../../lib/hash.ts';
import { nowIso } from '../../lib/time.ts';
import { bumpDue } from './last-seen.ts';
import { DEFAULT_TENANT_ID } from './tenants.ts';

// API keys for machine clients (spec 027). The plaintext secret is `dnk_live_<random>`; only its
// SHA-256 hash is stored, so a leaked DB doesn't leak usable keys. The secret is returned exactly
// once (at creation). Mirrors the other repos: a plain class over the shared bun:sqlite Database.

export type ApiKeyScope = 'read' | 'chat';
export const API_KEY_SCOPES: readonly ApiKeyScope[] = ['read', 'chat'];

/** Namespace prefix on every key, so a Bearer token can be recognised as ours before any DB hit. */
export const API_KEY_NAMESPACE = 'dnk_live_';
const PREFIX_LEN = API_KEY_NAMESPACE.length + 6; // namespace + 6 chars, kept for display/identification

export interface ApiKeyRow {
  id: string;
  user_id: string;
  tenant_id: string | null; // owning org (spec 029); null only for pre-migration rows (treat as default)
  name: string;
  key_hash: string;
  prefix: string;
  scopes: string; // JSON array
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  quota_limit: number | null; // per-key request-quota override (spec 028); null = plan default
}

/** Safe-to-return view (never includes the hash or secret). */
export interface ApiKeyView {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiKeyScope[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export type ResolveResult =
  | { status: 'ok'; key: ApiKeyRow }
  | { status: 'invalid' | 'revoked' | 'expired' };

function generateSecret(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return API_KEY_NAMESPACE + Buffer.from(bytes).toString('base64url');
}

export function parseScopes(row: Pick<ApiKeyRow, 'scopes'>): ApiKeyScope[] {
  try {
    const arr = JSON.parse(row.scopes) as unknown;
    return Array.isArray(arr) ? (arr.filter((s) => s === 'read' || s === 'chat') as ApiKeyScope[]) : [];
  } catch {
    return [];
  }
}

function toView(row: ApiKeyRow): ApiKeyView {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: parseScopes(row),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

export class ApiKeyRepo {
  constructor(private readonly db: Database) {}

  /** Create a key for a user, owned by a tenant (spec 029). Returns the plaintext ONCE. */
  create(input: {
    userId: string;
    tenantId?: string;
    name: string;
    scopes?: ApiKeyScope[];
    expiresAt?: string | null;
    now?: string;
  }): { plaintext: string; view: ApiKeyView } {
    const secret = generateSecret();
    const id = crypto.randomUUID();
    const now = input.now ?? nowIso();
    const scopes = (input.scopes && input.scopes.length > 0 ? input.scopes : [...API_KEY_SCOPES]).filter(
      (s, i, a) => a.indexOf(s) === i,
    );
    const prefix = secret.slice(0, PREFIX_LEN);
    this.db
      .query(
        'INSERT INTO api_keys (id, user_id, tenant_id, name, key_hash, prefix, scopes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        input.userId,
        input.tenantId ?? DEFAULT_TENANT_ID,
        input.name,
        sha256Hex(secret),
        prefix,
        JSON.stringify(scopes),
        now,
        input.expiresAt ?? null,
      );
    const row = this.db.query<ApiKeyRow, [string]>('SELECT * FROM api_keys WHERE id = ?').get(id);
    return { plaintext: secret, view: toView(row as ApiKeyRow) };
  }

  /**
   * Resolve a presented secret to its key row, rejecting unknown/revoked/expired. Bumps
   * `last_used_at` at most once per throttle window (spec 043 FR-254), so a keyed read in steady
   * state performs no write.
   */
  resolveBySecret(secret: string, now = nowIso()): ResolveResult {
    if (!secret.startsWith(API_KEY_NAMESPACE)) return { status: 'invalid' };
    const row = this.db
      .query<ApiKeyRow, [string]>('SELECT * FROM api_keys WHERE key_hash = ?')
      .get(sha256Hex(secret));
    if (!row) return { status: 'invalid' };
    if (row.revoked_at) return { status: 'revoked' };
    if (row.expires_at && row.expires_at <= now) return { status: 'expired' };
    if (bumpDue(row.last_used_at, now)) {
      this.db.query('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now, row.id);
    }
    return { status: 'ok', key: row };
  }

  /** The user's keys, newest first (views — never the hash). */
  listForUser(userId: string): ApiKeyView[] {
    return this.db
      .query<ApiKeyRow, [string]>('SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC')
      .all(userId)
      .map(toView);
  }

  /** All keys owned by a tenant, newest first (org-admin view, spec 029). */
  listForTenant(tenantId: string): ApiKeyView[] {
    return this.db
      .query<ApiKeyRow, [string]>(
        'SELECT * FROM api_keys WHERE tenant_id = ? ORDER BY created_at DESC',
      )
      .all(tenantId)
      .map(toView);
  }

  /** Revoke a key the user owns (idempotent). Returns true if a live key was revoked. */
  revoke(id: string, userId: string, now = nowIso()): boolean {
    const res = this.db
      .query('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
      .run(now, id, userId);
    return res.changes > 0;
  }
}
