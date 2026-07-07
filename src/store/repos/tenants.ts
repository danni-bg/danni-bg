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
  plan: string;
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

  get(id: string): TenantRow | null {
    return this.db.query<TenantRow, [string]>('SELECT * FROM tenants WHERE id = ?').get(id) ?? null;
  }

  getBySlug(slug: string): TenantRow | null {
    return (
      this.db.query<TenantRow, [string]>('SELECT * FROM tenants WHERE slug = ?').get(slug) ?? null
    );
  }

  /** All tenants (newest first) with their member count — backs the super-admin org list. */
  listAll(): (TenantRow & { memberCount: number })[] {
    return this.db
      .query<TenantRow & { memberCount: number }, []>(
        `SELECT t.*, (SELECT COUNT(*) FROM tenant_members m WHERE m.tenant_id = t.id) AS memberCount
         FROM tenants t ORDER BY t.created_at DESC`,
      )
      .all();
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

  /** Members of a tenant joined with their identity (for the org-admin view). */
  membersOf(tenantId: string): TenantMember[] {
    return this.db
      .query<
        { user_id: string; email: string; display_name: string | null; role: TenantRole },
        [string]
      >(
        `SELECT m.user_id, u.email, u.display_name, m.role
         FROM tenant_members m JOIN users u ON u.id = m.user_id
         WHERE m.tenant_id = ? ORDER BY m.created_at`,
      )
      .all(tenantId)
      .map((r) => ({
        userId: r.user_id,
        email: r.email,
        displayName: r.display_name,
        role: r.role,
      }));
  }
}
