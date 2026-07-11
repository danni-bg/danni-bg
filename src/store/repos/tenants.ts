import type { Database } from 'bun:sqlite';
import { nowIso } from '../../lib/time.ts';

// Organizations (tenants) and their membership (spec 029). A tenant is the top-level owner of users,
// API keys, usage, chat sessions, and per-portal config. Every gated request resolves an active
// tenant; tenant-owned reads/writes are scoped to it. Mirrors the other repos: a plain class over the
// shared bun:sqlite Database. (Named `tenants`, not `organizations`, because that table already holds
// egov dataset publishers — a different concept.)

/** The well-known tenant every existing user + row migrates into; new self-registered users join it. */
export const DEFAULT_TENANT_ID = 'default';

export type TenantRole = 'owner' | 'admin' | 'member';
export const TENANT_ROLES: readonly TenantRole[] = ['owner', 'admin', 'member'];

export interface TenantRow {
  id: string;
  name: string;
  slug: string;
  /**
   * Free-text plan label. DEFERRED (spec 040 FR-224): it is stored + echoed but maps to NO runtime
   * limit — no rate, request-quota, or token limit reads it. A future pricing/plans spec will resolve
   * default rate/quota/token limits from `plan`; until then, do not mistake this field for enforcement.
   */
  plan: string;
  /**
   * The org's assigned platform-routing token entitlement (spec 065). NULL = legacy (per-user
   * metering, unchanged); a value >= 0 = a pool-model org whose member allowances sum to <= this.
   * Set ONLY by a super-admin (the contract boundary, FR-600/602).
   */
  token_pool: number | null;
  /** Whether the org may Bring Its Own Model (spec 065 FR-601). 0/1; super-admin-set; off by default. */
  byom_enabled: number;
  created_at: string;
}

export interface Membership {
  tenantId: string;
  userId: string;
  role: TenantRole;
}

/** A tenant member joined with their identity, for the org-admin member list. */
export interface TenantMember {
  userId: string;
  email: string;
  displayName: string | null;
  role: TenantRole;
  /** The member's reserved token allowance within the org (spec 065); null = no allocation. */
  tokenLimit: number | null;
}

export class TenantsRepo {
  constructor(private readonly db: Database) {}

  create(input: { name: string; slug: string; plan?: string; now?: string }): TenantRow {
    const id = crypto.randomUUID();
    const now = input.now ?? nowIso();
    this.db
      .query('INSERT INTO tenants (id, name, slug, plan, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, input.name, input.slug, input.plan ?? 'default', now);
    return this.get(id) as TenantRow;
  }

  /**
   * Create an organization AND make `ownerUserId` its owner in ONE transaction (spec 052 FR-505):
   * a fault mid-creation leaves neither an orphan tenant nor an ownerless one. Backs self-serve org
   * creation (spec 064 FR-500) — the super-admin path keeps using `create` + a separate `addMember`.
   */
  createOwned(input: {
    name: string;
    slug: string;
    ownerUserId: string;
    plan?: string;
    now?: string;
  }): TenantRow {
    const id = crypto.randomUUID();
    const now = input.now ?? nowIso();
    this.db.transaction(() => {
      this.db
        .query('INSERT INTO tenants (id, name, slug, plan, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, input.name, input.slug, input.plan ?? 'default', now);
      this.db
        .query(
          "INSERT INTO tenant_members (tenant_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)",
        )
        .run(id, input.ownerUserId, now);
    })();
    return this.get(id) as TenantRow;
  }

  get(id: string): TenantRow | null {
    return this.db.query<TenantRow, [string]>('SELECT * FROM tenants WHERE id = ?').get(id) ?? null;
  }

  /** A free slug based on `base`, de-duplicated with a numeric suffix on collision (spec 064 FR-501). */
  uniqueSlug(base: string): string {
    if (!this.getBySlug(base)) return base;
    for (let i = 2; ; i++) {
      const candidate = `${base}-${i}`;
      if (!this.getBySlug(candidate)) return candidate;
    }
  }

  getBySlug(slug: string): TenantRow | null {
    return (
      this.db.query<TenantRow, [string]>('SELECT * FROM tenants WHERE slug = ?').get(slug) ?? null
    );
  }

  /** Tenants (newest first) with their member count — bounded + pageable (spec 056 FR-392). */
  listAll(limit = 100, offset = 0): (TenantRow & { memberCount: number })[] {
    return this.db
      .query<TenantRow & { memberCount: number }, [number, number]>(
        `SELECT t.*, (SELECT COUNT(*) FROM tenant_members m WHERE m.tenant_id = t.id) AS memberCount
         FROM tenants t ORDER BY t.created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(limit, offset);
  }

  /** Total tenants (drives the super-admin `/tenants` `total`, spec 056 FR-392). */
  countAll(): number {
    const row = this.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM tenants').get();
    return row?.n ?? 0;
  }

  /**
   * Add a user to a tenant — insert-only (spec 036 FR-180): if the user is already a member, their
   * existing role is left untouched. Returns true when a membership row was inserted, false when the
   * user was already a member (callers surface that as a conflict; role changes go via setMemberRole).
   */
  addMember(tenantId: string, userId: string, role: TenantRole = 'member', now = nowIso()): boolean {
    const res = this.db
      .query(
        `INSERT INTO tenant_members (tenant_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(tenant_id, user_id) DO NOTHING`,
      )
      .run(tenantId, userId, role, now);
    return res.changes > 0;
  }

  // ── entitlements (spec 065) ─────────────────────────────────────────────────────────────────────

  /** Set/clear the org's platform-routing token pool (super-admin only, FR-600). null → legacy. */
  setPool(tenantId: string, pool: number | null): void {
    this.db.query('UPDATE tenants SET token_pool = ? WHERE id = ?').run(pool, tenantId);
  }

  /** Enable/disable BYOM for the org (super-admin only, FR-601). */
  setByom(tenantId: string, enabled: boolean): void {
    this.db.query('UPDATE tenants SET byom_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, tenantId);
  }

  /** Sum of the org's members' reserved allowances — the pool amount already handed out (FR-611/612). */
  allocatedTokens(tenantId: string): number {
    const row = this.db
      .query<{ n: number }, [string]>(
        'SELECT COALESCE(SUM(token_limit), 0) AS n FROM tenant_members WHERE tenant_id = ?',
      )
      .get(tenantId);
    return row?.n ?? 0;
  }

  /** A member's reserved allowance within the org (null = no allocation). */
  memberAllowance(tenantId: string, userId: string): number | null {
    const row = this.db
      .query<{ token_limit: number | null }, [string, string]>(
        'SELECT token_limit FROM tenant_members WHERE tenant_id = ? AND user_id = ?',
      )
      .get(tenantId, userId);
    return row ? row.token_limit : null;
  }

  /** Set/clear a member's reserved allowance (org owner/admin, FR-610). Returns false if not a member. */
  setMemberAllowance(tenantId: string, userId: string, limit: number | null): boolean {
    const res = this.db
      .query('UPDATE tenant_members SET token_limit = ? WHERE tenant_id = ? AND user_id = ?')
      .run(limit, tenantId, userId);
    return res.changes > 0;
  }

  /** How many orgs a user OWNS — bounds self-serve org creation (spec 064 FR-502). */
  ownedCount(userId: string): number {
    const row = this.db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM tenant_members WHERE user_id = ? AND role = 'owner'",
      )
      .get(userId);
    return row?.n ?? 0;
  }

  /** How many owners a tenant has — guards the zero-owner invariant (spec 036 FR-182). */
  ownerCount(tenantId: string): number {
    const row = this.db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM tenant_members WHERE tenant_id = ? AND role = 'owner'",
      )
      .get(tenantId);
    return row?.n ?? 0;
  }

  setMemberRole(tenantId: string, userId: string, role: TenantRole): boolean {
    const res = this.db
      .query('UPDATE tenant_members SET role = ? WHERE tenant_id = ? AND user_id = ?')
      .run(role, tenantId, userId);
    return res.changes > 0;
  }

  removeMember(tenantId: string, userId: string): boolean {
    const res = this.db
      .query('DELETE FROM tenant_members WHERE tenant_id = ? AND user_id = ?')
      .run(tenantId, userId);
    return res.changes > 0;
  }

  membershipOf(tenantId: string, userId: string): Membership | null {
    const row = this.db
      .query<{ role: TenantRole }, [string, string]>(
        'SELECT role FROM tenant_members WHERE tenant_id = ? AND user_id = ?',
      )
      .get(tenantId, userId);
    return row ? { tenantId, userId, role: row.role } : null;
  }

  /** A user's memberships (the order is creation order — the first is treated as their primary). */
  membershipsOf(userId: string): Membership[] {
    return this.db
      .query<{ tenant_id: string; role: TenantRole }, [string]>(
        'SELECT tenant_id, role FROM tenant_members WHERE user_id = ? ORDER BY created_at',
      )
      .all(userId)
      .map((r) => ({ tenantId: r.tenant_id, userId, role: r.role }));
  }

  /** The user's primary (oldest) membership, or null if they belong to no tenant yet. */
  primaryMembership(userId: string): Membership | null {
    return this.membershipsOf(userId)[0] ?? null;
  }

  /**
   * A user's memberships joined with each org's name + slug (spec 064 FR-504) — drives the org
   * console's labelled list in one call. Creation order, like `membershipsOf`.
   */
  membershipsDetailed(
    userId: string,
  ): { tenantId: string; name: string; slug: string; role: TenantRole }[] {
    return this.db
      .query<{ tenant_id: string; name: string; slug: string; role: TenantRole }, [string]>(
        `SELECT m.tenant_id, t.name, t.slug, m.role
         FROM tenant_members m JOIN tenants t ON t.id = m.tenant_id
         WHERE m.user_id = ? ORDER BY m.created_at`,
      )
      .all(userId)
      .map((r) => ({ tenantId: r.tenant_id, name: r.name, slug: r.slug, role: r.role }));
  }

  /**
   * Ensure the user belongs to ≥1 tenant, joining the default tenant as `member` if they have none.
   * Returns the user's primary membership. Called on every gated request so a freshly self-registered
   * user lands in the default tenant (single-portal behavior) without a separate provisioning step.
   */
  ensureMembership(userId: string, now = nowIso()): Membership {
    const existing = this.primaryMembership(userId);
    if (existing) return existing;
    this.addMember(DEFAULT_TENANT_ID, userId, 'member', now);
    return { tenantId: DEFAULT_TENANT_ID, userId, role: 'member' };
  }

  /**
   * Resolve the caller's active membership (spec 041 FR-230): honour their persisted `preferredTenantId`
   * selection when it is still a membership, else fall back to the primary (oldest) membership —
   * today's behavior. Ensures ≥1 membership first, so a fresh user still lands in the default tenant.
   * A user who never switched (null selection) resolves to their primary, unchanged (FR-235).
   */
  activeMembership(userId: string, preferredTenantId: string | null, now = nowIso()): Membership {
    const primary = this.ensureMembership(userId, now);
    if (!preferredTenantId || preferredTenantId === primary.tenantId) return primary;
    return this.membershipOf(preferredTenantId, userId) ?? primary;
  }

  /** Members of a tenant joined with their identity + reserved allowance (for the org-admin view). */
  membersOf(tenantId: string): TenantMember[] {
    return this.db
      .query<
        {
          user_id: string;
          email: string;
          display_name: string | null;
          role: TenantRole;
          token_limit: number | null;
        },
        [string]
      >(
        `SELECT m.user_id, u.email, u.display_name, m.role, m.token_limit
         FROM tenant_members m JOIN users u ON u.id = m.user_id
         WHERE m.tenant_id = ? ORDER BY m.created_at`,
      )
      .all(tenantId)
      .map((r) => ({
        userId: r.user_id,
        email: r.email,
        displayName: r.display_name,
        role: r.role,
        tokenLimit: r.token_limit,
      }));
  }
}
