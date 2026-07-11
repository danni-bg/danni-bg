// Organization (tenant) self-management (spec 029), under requireAuth. Any member can read their
// active org + role; owners/admins manage members (FR-132). Human-session only — an API key acts
// within its org but can never administer it. Super-admin org CRUD lives in routes/admin.ts.

import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { slugify } from '../../../../src/lib/slug.ts';
import type { PlatformSettingsRepo } from '../../../../src/store/repos/platform-settings.ts';
import type { TenantRole, TenantsRepo } from '../../../../src/store/repos/tenants.ts';
import type { UsersRepo } from '../../../../src/store/repos/users.ts';

/** Anti-abuse cap on self-serve org creation (spec 064 FR-502): orgs a single user may OWN. */
export const MAX_ORGS_OWNED_PER_USER = 10;
import {
  applyTenantSettings,
  tenantSettingsPutSchema,
  tenantSettingsView,
} from '../admin/tenant-settings.ts';
import { parseBody } from '../middleware/parse-body.ts';
import { type AuthEnv, requireHuman, requireTenantAdmin } from '../middleware/require-auth.ts';

const createOrgBody = z.object({ name: z.string().trim().min(1).max(80) });
const allowanceBody = z.object({ limit: z.number().int().nonnegative().nullable() });
// Org profile (spec 067): contact email + description text, and a picture as a resized data: URL
// (same cap/shape as the user avatar, routes/me.ts). Empty text is normalized to null client-side.
const profileBody = z.object({
  contactEmail: z.string().email().nullable(),
  description: z.string().max(2000).nullable(),
});
const MAX_AVATAR_CHARS = 600_000;
const orgAvatarBody = z.object({
  avatarUrl: z
    .string()
    .regex(/^data:image\/(png|jpeg|webp);base64,/, 'must be a data:image URL')
    .max(MAX_AVATAR_CHARS)
    .nullable(),
});
const addMemberBody = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'member']).optional(), // a new owner is set via PATCH, not add
});
const setRoleBody = z.object({ role: z.enum(['owner', 'admin', 'member']) });
const switchBody = z.object({ tenantId: z.string().min(1) });

export interface TenantRoutesOpts {
  /** The shared auth gate (spec 055 FR-375), composed once in app.ts. */
  gate: MiddlewareHandler<AuthEnv>;
  apiKeys?: import('../../../../src/store/repos/api-keys.ts').ApiKeyRepo | undefined;
  /** Platform settings repo — backs the org-admin per-tenant settings surface (spec 042 FR-242). */
  settings?: PlatformSettingsRepo | undefined;
}

export function tenantRoutes(
  users: UsersRepo,
  tenants: TenantsRepo,
  opts: TenantRoutesOpts,
): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use('*', opts.gate);

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
      // Organization profile (spec 067) — visible to any member.
      contactEmail: t.contact_email,
      description: t.description,
      avatarUrl: t.avatar_url,
      // Entitlement context (spec 065): BYOM state + the caller's OWN reserved slice are visible to any
      // member; the pool + allocation figures + member list are admin-only (FR-612/651).
      byomEnabled: t.byom_enabled === 1,
      myAllowance: tenants.memberAllowance(t.id, c.get('user').id),
      ...(isAdmin
        ? {
            members: tenants.membersOf(t.id),
            pool: t.token_pool,
            allocated: tenants.allocatedTokens(t.id),
            unallocated:
              t.token_pool === null
                ? null
                : Math.max(0, t.token_pool - tenants.allocatedTokens(t.id)),
          }
        : {}),
    });
  });

  // The caller's org memberships (every org they belong to), each with its name + slug (spec 064
  // FR-504) so the console renders a labelled list in one call.
  app.get('/memberships', (c) =>
    c.json({ memberships: tenants.membershipsDetailed(c.get('user').id) }),
  );

  // Self-serve org creation (spec 064 FR-500): the caller creates a new organization, becomes its
  // OWNER, and their active org switches to it — atomically. Human-session only (an API key can never
  // create an org). Bounded by MAX_ORGS_OWNED_PER_USER (FR-502).
  app.post('/', requireHuman, async (c) => {
    const parsed = await parseBody(c, createOrgBody, { message: 'invalid organization' });
    if (parsed instanceof Response) return parsed;
    const user = c.get('user');
    if (tenants.ownedCount(user.id) >= MAX_ORGS_OWNED_PER_USER) {
      return c.json(
        {
          error: {
            code: 'org_limit',
            message: `you can own at most ${MAX_ORGS_OWNED_PER_USER} organizations`,
          },
        },
        403,
      );
    }
    // A Cyrillic name yields a readable Cyrillic slug; a name that slugifies to empty (all
    // punctuation/emoji) falls back to a stable generated token so the slug is never blank.
    const base = slugify(parsed.name) || `org-${crypto.randomUUID().slice(0, 8)}`;
    const slug = tenants.uniqueSlug(base);
    const t = tenants.createOwned({ name: parsed.name, slug, ownerUserId: user.id });
    users.setActiveTenant(user.id, t.id);
    return c.json({ id: t.id, name: t.name, slug: t.slug, role: 'owner' as TenantRole }, 201);
  });

  // Switch the caller's active org (spec 041 FR-231) — human-session only: a key is tenant-bound and
  // must never mutate its owner's persisted selection. The target must be one of the caller's
  // memberships; switching elsewhere is rejected without changing the active selection.
  app.post('/switch', requireHuman, async (c) => {
    const parsed = await parseBody(c, switchBody, { message: 'invalid switch request' });
    if (parsed instanceof Response) return parsed;
    const user = c.get('user');
    const target = tenants.membershipOf(parsed.tenantId, user.id);
    if (!target) {
      return c.json({ error: { code: 'not_found', message: 'not a member of that org' } }, 404);
    }
    users.setActiveTenant(user.id, target.tenantId);
    const t = tenants.get(target.tenantId);
    return c.json({ ok: true, id: t?.id, slug: t?.slug, role: target.role });
  });

  // Organization profile (spec 067): org owner/admins set the contact email + description, and the
  // picture (a resized data: URL) via a separate endpoint mirroring the user avatar.
  app.put('/profile', requireTenantAdmin, async (c) => {
    const parsed = await parseBody(c, profileBody, { message: 'invalid profile' });
    if (parsed instanceof Response) return parsed;
    tenants.setProfile(c.get('tenant').id, parsed.contactEmail, parsed.description);
    return c.json({ ok: true, contactEmail: parsed.contactEmail, description: parsed.description });
  });
  app.put('/avatar', requireTenantAdmin, async (c) => {
    const parsed = await parseBody(c, orgAvatarBody, { message: 'invalid avatar' });
    if (parsed instanceof Response) return parsed;
    tenants.setAvatar(c.get('tenant').id, parsed.avatarUrl);
    return c.json({ avatarUrl: parsed.avatarUrl });
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
    const byomEnabled = (tenantId: string) => tenants.get(tenantId)?.byom_enabled === 1;
    const settingsView = (tenantId: string) => ({
      ...tenantSettingsView(settings, tenantId),
      // spec 065 FR-631: the console shows the LLM (BYOM) section only when BYOM is enabled.
      byomEnabled: byomEnabled(tenantId),
    });
    app.get('/settings', requireTenantAdmin, (c) => c.json(settingsView(c.get('tenant').id)));
    app.put('/settings', requireTenantAdmin, async (c) => {
      // `.strict()` (in the schema) rejects any non-allowlisted field (a platform toggle / api
      // rate-quota knob) with a 400 that writes nothing (FR-241 / SC-3).
      const parsed = await parseBody(c, tenantSettingsPutSchema, {
        message: 'invalid settings',
        details: 'flatten',
      });
      if (parsed instanceof Response) return parsed;
      // BYOM gate (spec 065 FR-630): setting an LLM override requires the super-admin to have enabled
      // BYOM for this org. Clearing (llm: null) is always allowed. Nothing is written on a 403.
      if (parsed.llm && !byomEnabled(c.get('tenant').id)) {
        return c.json(
          {
            error: { code: 'byom_disabled', message: 'BYOM is not enabled for this organization' },
          },
          403,
        );
      }
      applyTenantSettings(settings, c.get('tenant').id, parsed, c.get('user').email);
      return c.json(settingsView(c.get('tenant').id));
    });
  }

  // Add an EXISTING user (by email) to the active org. Org admins may add member/admin; only owners
  // promote to owner (via PATCH). The invitee must already have an account (have signed in once).
  app.post('/members', requireTenantAdmin, async (c) => {
    const parsed = await parseBody(c, addMemberBody, { message: 'invalid member request' });
    if (parsed instanceof Response) return parsed;
    const invitee = users.findByEmail(parsed.email);
    if (!invitee) {
      return c.json({ error: { code: 'not_found', message: 'no user with that email' } }, 404);
    }
    const role: TenantRole = parsed.role ?? 'member';
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

  // Set a member's RESERVED token allowance within the org (spec 065 FR-610). Pool-model orgs only;
  // the change is rejected if the resulting sum of allowances would exceed the pool (FR-611).
  app.put('/members/:userId/allowance', requireTenantAdmin, async (c) => {
    const parsed = await parseBody(c, allowanceBody, { message: 'invalid allowance' });
    if (parsed instanceof Response) return parsed;
    const active = c.get('tenant');
    const t = tenants.get(active.id);
    if (t?.token_pool == null) {
      return c.json(
        { error: { code: 'no_pool', message: 'this organization has no token pool' } },
        400,
      );
    }
    const userId = c.req.param('userId');
    if (!tenants.membershipOf(active.id, userId)) {
      return c.json({ error: { code: 'not_found', message: 'no such member' } }, 404);
    }
    // Reserved invariant: (current allocations − this member's current − new) must fit the pool.
    const current = tenants.memberAllowance(active.id, userId) ?? 0;
    const next = parsed.limit ?? 0;
    const projected = tenants.allocatedTokens(active.id) - current + next;
    if (projected > t.token_pool) {
      return c.json(
        {
          error: {
            code: 'over_pool',
            message: 'allocation would exceed the organization’s token pool',
            details: { pool: t.token_pool, allocated: tenants.allocatedTokens(active.id) },
          },
        },
        400,
      );
    }
    tenants.setMemberAllowance(active.id, userId, parsed.limit);
    return c.json({ ok: true, userId, allowance: parsed.limit });
  });

  // Change a member's role. Only an owner may grant/transfer the owner role — or change an owner's
  // role at all (spec 036 FR-181); and no path may demote the org's last owner (FR-182).
  app.patch('/members/:userId', requireTenantAdmin, async (c) => {
    const parsed = await parseBody(c, setRoleBody, { message: 'invalid role' });
    if (parsed instanceof Response) return parsed;
    const active = c.get('tenant');
    const target = tenants.membershipOf(active.id, c.req.param('userId'));
    if (!target) {
      return c.json({ error: { code: 'not_found', message: 'no such member' } }, 404);
    }
    // Owner-gate both directions: granting `owner` AND any change targeting a current owner.
    if ((parsed.role === 'owner' || target.role === 'owner') && active.role !== 'owner') {
      return c.json(
        { error: { code: 'forbidden', message: 'only an owner can grant or change ownership' } },
        403,
      );
    }
    // Demoting an owner must never leave the org ownerless.
    if (target.role === 'owner' && parsed.role !== 'owner' && tenants.ownerCount(active.id) <= 1) {
      return c.json(
        { error: { code: 'last_owner', message: 'cannot demote the last owner' } },
        400,
      );
    }
    tenants.setMemberRole(active.id, target.userId, parsed.role);
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
    // Owner-gate removal (spec 065 FR-640): only an owner may remove an owner — mirrors the PATCH
    // owner-gate (spec 036 FR-181), closing the gap where an admin could remove a non-last owner. The
    // last-owner floor needs no explicit check HERE: a non-owner can't remove an owner (above), an
    // owner can't remove themselves (above), so an owner removing an owner implies ≥2 owners — the org
    // always keeps ≥1. (The super-admin route, which has no owner-gate, retains its last-owner check.)
    if (member.role === 'owner' && active.role !== 'owner') {
      return c.json(
        { error: { code: 'forbidden', message: 'only an owner can remove an owner' } },
        403,
      );
    }
    tenants.removeMember(active.id, target);
    return c.json({ ok: true });
  });

  return app;
}
