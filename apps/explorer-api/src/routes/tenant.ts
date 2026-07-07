// Organization (tenant) self-management (spec 029), under requireAuth. Any member can read their
// active org + role; owners/admins manage members (FR-132). Human-session only — an API key acts
// within its org but can never administer it. Super-admin org CRUD lives in routes/admin.ts.

import { Hono } from 'hono';
import { z } from 'zod';
import type { PlatformSettingsRepo } from '../../../../src/store/repos/platform-settings.ts';
import type { TenantRole, TenantsRepo } from '../../../../src/store/repos/tenants.ts';
import type { UsersRepo } from '../../../../src/store/repos/users.ts';
import {
  applyTenantSettings,
  tenantSettingsPutSchema,
  tenantSettingsView,
} from '../admin/tenant-settings.ts';
import type { SessionResolver } from '../auth/kratos-session.ts';
import {
  type AuthEnv,
  requireAuth,
  requireHuman,
  requireTenantAdmin,
} from '../middleware/require-auth.ts';

const addMemberBody = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'member']).optional(), // a new owner is set via PATCH, not add
});
const setRoleBody = z.object({ role: z.enum(['owner', 'admin', 'member']) });
const switchBody = z.object({ tenantId: z.string().min(1) });

export interface TenantRoutesOpts {
  sessionResolver?: SessionResolver | undefined;
  apiKeys?: import('../../../../src/store/repos/api-keys.ts').ApiKeyRepo | undefined;
  /** Platform settings repo — backs the org-admin per-tenant settings surface (spec 042 FR-242). */
  settings?: PlatformSettingsRepo | undefined;
}

export function tenantRoutes(
  users: UsersRepo,
  tenants: TenantsRepo,
  opts: TenantRoutesOpts = {},
): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use('*', requireAuth(users, opts.sessionResolver, opts.apiKeys, tenants));

  // The caller's active org + their role (any member). Members listed only for org admins.
  app.get('/', (c) => {
    const active = c.get('tenant');
    const t = tenants.get(active.id);
    if (!t) return c.json({ error: { code: 'not_found', message: 'no active org' } }, 404);
    const isAdmin = active.role === 'owner' || active.role === 'admin';
    return c.json({
      id: t.id,
      name: t.name,
      slug: t.slug,
      // `plan` is echoed for display only — it drives no limit (spec 040 FR-224, deferred to a pricing
      // spec). Rate/quota/token caps come from platform (or per-tenant, spec 042) settings, not here.
      plan: t.plan,
      role: active.role,
      ...(isAdmin ? { members: tenants.membersOf(t.id) } : {}),
    });
  });

  // The caller's org memberships (every org they belong to).
  app.get('/memberships', (c) => c.json({ memberships: tenants.membershipsOf(c.get('user').id) }));

  // Switch the caller's active org (spec 041 FR-231) — human-session only: a key is tenant-bound and
  // must never mutate its owner's persisted selection. The target must be one of the caller's
  // memberships; switching elsewhere is rejected without changing the active selection.
  app.post('/switch', requireHuman, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: 'bad_request', message: 'invalid JSON body' } }, 400);
    }
    const parsed = switchBody.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'bad_request', message: 'invalid switch request' } }, 400);
    }
    const user = c.get('user');
    const target = tenants.membershipOf(parsed.data.tenantId, user.id);
    if (!target) {
      return c.json({ error: { code: 'not_found', message: 'not a member of that org' } }, 404);
    }
    users.setActiveTenant(user.id, target.tenantId);
    const t = tenants.get(target.tenantId);
    return c.json({ ok: true, id: t?.id, slug: t?.slug, role: target.role });
  });

  app.get('/members', requireTenantAdmin, (c) =>
    c.json({ members: tenants.membersOf(c.get('tenant').id) }),
  );

  // Tenant-scoped API-key view for org admins (spec 041 FR-234) — views only (never hashes/secrets,
  // consistent with spec 027). Scoped to the caller's active org, so an admin of one org can never see
  // another org's keys (spec 029 SC-C1). Only wired when an ApiKeyRepo is present.
  const apiKeys = opts.apiKeys;
  if (apiKeys) {
    app.get('/api-keys', requireTenantAdmin, (c) =>
      c.json({ keys: apiKeys.listForTenant(c.get('tenant').id) }),
    );
  }

  // Per-tenant runtime settings (spec 042 FR-242): org admins view/set/clear ONLY their org's
  // overridable keys (the LLM provider + `defaultTokenLimit`), scoped to the active org. The view is
  // masked and isolation-safe — it never returns the global (or another tenant's) secret, and an
  // inherited LLM config exposes no key hint (FR-243). Only wired when a settings repo is present.
  const settings = opts.settings;
  if (settings) {
    app.get('/settings', requireTenantAdmin, (c) =>
      c.json(tenantSettingsView(settings, c.get('tenant').id)),
    );
    app.put('/settings', requireTenantAdmin, async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: { code: 'bad_request', message: 'invalid JSON body' } }, 400);
      }
      // `.strict()` rejects any non-allowlisted field (a platform toggle / api rate-quota knob) with a
      // 400 that writes nothing (FR-241 / SC-3).
      const parsed = tenantSettingsPutSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          {
            error: {
              code: 'bad_request',
              message: 'invalid settings',
              details: parsed.error.flatten(),
            },
          },
          400,
        );
      }
      applyTenantSettings(settings, c.get('tenant').id, parsed.data, c.get('user').email);
      return c.json(tenantSettingsView(settings, c.get('tenant').id));
    });
  }

  // Add an EXISTING user (by email) to the active org. Org admins may add member/admin; only owners
  // promote to owner (via PATCH). The invitee must already have an account (have signed in once).
  app.post('/members', requireTenantAdmin, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: 'bad_request', message: 'invalid JSON body' } }, 400);
    }
    const parsed = addMemberBody.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'bad_request', message: 'invalid member request' } }, 400);
    }
    const invitee = users.findByEmail(parsed.data.email);
    if (!invitee) {
      return c.json({ error: { code: 'not_found', message: 'no user with that email' } }, 404);
    }
    const role: TenantRole = parsed.data.role ?? 'member';
    // Insert-only (spec 036 FR-180): re-adding an existing member must never touch their role —
    // otherwise "re-adding" the owner as `member` would silently strip ownership.
    if (!tenants.addMember(c.get('tenant').id, invitee.id, role)) {
      return c.json(
        { error: { code: 'already_member', message: 'user is already a member of this org' } },
        409,
      );
    }
    return c.json({ ok: true, member: { userId: invitee.id, email: invitee.email, role } }, 201);
  });

  // Change a member's role. Only an owner may grant/transfer the owner role — or change an owner's
  // role at all (spec 036 FR-181); and no path may demote the org's last owner (FR-182).
  app.patch('/members/:userId', requireTenantAdmin, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: 'bad_request', message: 'invalid JSON body' } }, 400);
    }
    const parsed = setRoleBody.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'bad_request', message: 'invalid role' } }, 400);
    }
    const active = c.get('tenant');
    const target = tenants.membershipOf(active.id, c.req.param('userId'));
    if (!target) {
      return c.json({ error: { code: 'not_found', message: 'no such member' } }, 404);
    }
    // Owner-gate both directions: granting `owner` AND any change targeting a current owner.
    if ((parsed.data.role === 'owner' || target.role === 'owner') && active.role !== 'owner') {
      return c.json(
        { error: { code: 'forbidden', message: 'only an owner can grant or change ownership' } },
        403,
      );
    }
    // Demoting an owner must never leave the org ownerless.
    if (
      target.role === 'owner' &&
      parsed.data.role !== 'owner' &&
      tenants.ownerCount(active.id) <= 1
    ) {
      return c.json(
        { error: { code: 'last_owner', message: 'cannot demote the last owner' } },
        400,
      );
    }
    tenants.setMemberRole(active.id, target.userId, parsed.data.role);
    return c.json({ ok: true });
  });

  // Remove a member. You cannot remove yourself (leave is a separate, deliberate flow) or the org's
  // last owner (which would orphan the org).
  app.delete('/members/:userId', requireTenantAdmin, (c) => {
    const active = c.get('tenant');
    const target = c.req.param('userId');
    if (target === c.get('user').id) {
      return c.json({ error: { code: 'bad_request', message: 'cannot remove yourself' } }, 400);
    }
    const member = tenants.membershipOf(active.id, target);
    if (!member) {
      return c.json({ error: { code: 'not_found', message: 'no such member' } }, 404);
    }
    if (member.role === 'owner' && tenants.ownerCount(active.id) <= 1) {
      return c.json(
        { error: { code: 'bad_request', message: 'cannot remove the last owner' } },
        400,
      );
    }
    tenants.removeMember(active.id, target);
    return c.json({ ok: true });
  });

  return app;
}
