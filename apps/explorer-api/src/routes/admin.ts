// Admin platform settings API (spec 019), under requireAuth + requireAdmin. GET returns the current
// settings with the LLM API key MASKED (never raw); PUT validates + persists, treating an empty key
// as "keep existing". The chat's default provider is resolved from these settings per request.

import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { PlatformSettingsRepo } from '../../../../src/store/repos/platform-settings.ts';
import type { TenantsRepo } from '../../../../src/store/repos/tenants.ts';
import type { TokenUsageRepo } from '../../../../src/store/repos/token-usage.ts';
import type { UsersRepo } from '../../../../src/store/repos/users.ts';
import {
  LLM_SETTING_KEY,
  type LlmSetting,
  TOGGLES_SETTING_KEY,
  llmSettingSchema,
  maskApiKey,
  mergeSecret,
  settingsPutSchema,
  togglesSchema,
} from '../admin/settings-schema.ts';
import { clearTenantSettings, tenantSettingsView } from '../admin/tenant-settings.ts';
import { serverDefaultFromEnv } from '../chat/providers.ts';
import { billableTokens, effectiveLimit, quotaView } from '../chat/quota.ts';
import { parseBody } from '../middleware/parse-body.ts';
import { type AuthEnv, requireAdmin } from '../middleware/require-auth.ts';

function maskedLlm(settings: PlatformSettingsRepo): {
  source: 'settings' | 'env';
  llm: {
    kind: string;
    model: string;
    baseUrl: string | null;
    apiKeyMasked: boolean;
    apiKeyHint: string | null;
  } | null;
} {
  const raw = settings.get(LLM_SETTING_KEY);
  if (raw != null) {
    const v = llmSettingSchema.parse(raw);
    return {
      source: 'settings',
      llm: { kind: v.kind, model: v.model, baseUrl: v.baseUrl ?? null, ...maskApiKey(v.apiKey) },
    };
  }
  const env = serverDefaultFromEnv(process.env);
  if (env) {
    return {
      source: 'env',
      llm: {
        kind: env.kind,
        model: env.model,
        baseUrl: env.baseUrl ?? null,
        ...maskApiKey(env.apiKey),
      },
    };
  }
  return { source: 'env', llm: null };
}

function togglesView(settings: PlatformSettingsRepo): Record<string, unknown> {
  const raw = settings.get(TOGGLES_SETTING_KEY);
  return raw != null ? togglesSchema.parse(raw) : {};
}

export interface AdminRoutesOpts {
  /** The shared auth gate (spec 055 FR-375), composed once in app.ts. */
  gate: MiddlewareHandler<AuthEnv>;
  apiKeys?: import('../../../../src/store/repos/api-keys.ts').ApiKeyRepo | undefined;
  apiUsage?: import('../../../../src/store/repos/api-usage.ts').ApiUsageRepo | undefined;
  apiQuotaWindowSec?: (() => number) | undefined;
  tokenUsage?: TokenUsageRepo | undefined;
  tenants?: TenantsRepo | undefined;
  defaultTokenLimit?: (() => number | undefined) | undefined;
  cacheWeight?: (() => number | undefined) | undefined;
}

const createTenantBody = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase letters, digits, or hyphens'),
  plan: z.string().trim().min(1).max(40).optional(),
});

// Super-admin member seeding (spec 041 FR-232): a platform admin may add ANY role on ANY org — unlike
// the self-service add (member/admin only), this may set `owner` to seed a freshly created org's first
// owner. A platform admin outranks org owners, so no owner-CALLER gate applies here.
const adminAddMemberBody = z.object({
  email: z.string().email(),
  role: z.enum(['owner', 'admin', 'member']).optional(),
});

export function adminRoutes(
  users: UsersRepo,
  settings: PlatformSettingsRepo,
  opts: AdminRoutesOpts,
): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  // The shared gate authenticates (incl. API keys) then requireAdmin cleanly 403s a key (never admin).
  app.use('*', opts.gate, requireAdmin);

  app.get('/settings', (c) => {
    const { source, llm } = maskedLlm(settings);
    return c.json({ llm, toggles: togglesView(settings), source });
  });

  app.put('/settings', async (c) => {
    const parsed = await parseBody(c, settingsPutSchema, {
      message: 'invalid settings',
      details: 'flatten',
    });
    if (parsed instanceof Response) return parsed;
    const by = c.get('user').email;
    if (parsed.llm) {
      const existing = settings.get(LLM_SETTING_KEY) as LlmSetting | null;
      const merged: LlmSetting = {
        kind: parsed.llm.kind,
        model: parsed.llm.model,
        baseUrl: parsed.llm.baseUrl ?? null,
        apiKey: mergeSecret(parsed.llm.apiKey, existing?.apiKey),
      };
      settings.set(LLM_SETTING_KEY, merged, by);
    }
    if (parsed.toggles) settings.set(TOGGLES_SETTING_KEY, parsed.toggles, by);
    const { source, llm } = maskedLlm(settings);
    return c.json({ llm, toggles: togglesView(settings), source });
  });

  // Per-principal API request usage (spec 028) over the current quota window — emails resolved; an
  // org key's usage also rolls up under its org (spec 029 SC-C3) when a tenants repo is wired.
  const apiUsage = opts.apiUsage;
  const tenants = opts.tenants;
  if (apiUsage) {
    app.get('/api-usage', (c) => {
      const windowSec = opts.apiQuotaWindowSec?.() ?? 86_400;
      const since = new Date(Date.now() - windowSec * 1000).toISOString();
      const principals = apiUsage.summaryAll(since).map((r) => ({
        ...r,
        email: users.get(r.principalId)?.email ?? null,
      }));
      const byTenant = apiUsage.summaryByTenant(since).map((r) => ({
        ...r,
        name: tenants?.get(r.tenantId)?.name ?? null,
      }));
      return c.json({ windowSec, principals, byTenant });
    });
  }

  // Per-key request-quota override (spec 040 FR-221): a super-admin sets/clears a key's `quota_limit`.
  // Per-key limits are billing policy — key owners never set their own (that path is /api/me, human +
  // owner-scoped, and deliberately has no quota knob). Gated by requireAdmin above, which a machine key
  // can never satisfy. `null` clears the override, falling the key back to the plan/platform default.
  const apiKeys = opts.apiKeys;
  if (apiKeys) {
    const quotaBody = z.object({ limit: z.number().int().nonnegative().nullable() });
    app.put('/api-keys/:id/quota', async (c) => {
      const parsed = await parseBody(c, quotaBody, { message: 'invalid quota limit' });
      if (parsed instanceof Response) return parsed;
      if (!apiKeys.setQuotaLimit(c.req.param('id'), parsed.limit)) {
        return c.json({ error: { code: 'not_found', message: 'no such key' } }, 404);
      }
      return c.json({ ok: true, quotaLimit: parsed.limit });
    });
  }

  // Super-admin org management (spec 029 FR-132): list every org + create a new one. Member seeding
  // (spec 041 FR-232) lets a platform admin add/remove a member on ANY org — a platform admin outranks
  // org owners so the owner-CALLER rule is bypassed, but the zero-owner invariant (spec 036 FR-182) is
  // still enforced on removal so a seeded org can never be left ownerless from this surface.
  if (tenants) {
    app.get('/tenants', (c) => c.json({ tenants: tenants.listAll() }));

    // Super-admin view/recovery of any org's overrides (spec 042 FR-244): inspect a tenant's
    // effective (masked) settings and clear all of its overrides so a misconfigured org falls back to
    // global without SQL. The view reuses the tenant-facing, isolation-safe masking (never a secret).
    app.get('/tenants/:id/settings', (c) => {
      const tenant = tenants.get(c.req.param('id'));
      if (!tenant) return c.json({ error: { code: 'not_found', message: 'no such org' } }, 404);
      return c.json(tenantSettingsView(settings, tenant.id));
    });
    app.delete('/tenants/:id/settings', (c) => {
      const tenant = tenants.get(c.req.param('id'));
      if (!tenant) return c.json({ error: { code: 'not_found', message: 'no such org' } }, 404);
      clearTenantSettings(settings, tenant.id);
      return c.json(tenantSettingsView(settings, tenant.id));
    });
    app.post('/tenants', async (c) => {
      const parsed = await parseBody(c, createTenantBody, { message: 'invalid org' });
      if (parsed instanceof Response) return parsed;
      if (tenants.getBySlug(parsed.slug)) {
        return c.json({ error: { code: 'conflict', message: 'slug already in use' } }, 409);
      }
      const created = tenants.create({
        name: parsed.name,
        slug: parsed.slug,
        ...(parsed.plan ? { plan: parsed.plan } : {}),
      });
      return c.json(created, 201);
    });

    // Add an existing user (by email) to any org, with any role (owner allowed — seeds the first
    // owner). Insert-only (spec 036 FR-180): re-adding an existing member is a 409, never a role change.
    app.post('/tenants/:id/members', async (c) => {
      const tenant = tenants.get(c.req.param('id'));
      if (!tenant) return c.json({ error: { code: 'not_found', message: 'no such org' } }, 404);
      const parsed = await parseBody(c, adminAddMemberBody, { message: 'invalid member request' });
      if (parsed instanceof Response) return parsed;
      const invitee = users.findByEmail(parsed.email);
      if (!invitee) {
        return c.json({ error: { code: 'not_found', message: 'no user with that email' } }, 404);
      }
      const role = parsed.role ?? 'member';
      if (!tenants.addMember(tenant.id, invitee.id, role)) {
        return c.json(
          { error: { code: 'already_member', message: 'user is already a member of this org' } },
          409,
        );
      }
      return c.json({ ok: true, member: { userId: invitee.id, email: invitee.email, role } }, 201);
    });

    // Remove a member from any org. The org's last owner cannot be removed (would orphan it, FR-182).
    app.delete('/tenants/:id/members/:userId', (c) => {
      const tenant = tenants.get(c.req.param('id'));
      if (!tenant) return c.json({ error: { code: 'not_found', message: 'no such org' } }, 404);
      const member = tenants.membershipOf(tenant.id, c.req.param('userId'));
      if (!member) return c.json({ error: { code: 'not_found', message: 'no such member' } }, 404);
      if (member.role === 'owner' && tenants.ownerCount(tenant.id) <= 1) {
        return c.json(
          { error: { code: 'last_owner', message: 'cannot remove the last owner' } },
          400,
        );
      }
      tenants.removeMember(tenant.id, member.userId);
      return c.json({ ok: true });
    });
  }

  // Per-user token usage + quota admin (token metering). Only wired when a usage repo is present.
  const usage = opts.tokenUsage;
  if (usage) {
    app.get('/usage', (c) => {
      const defaultLimit = opts.defaultTokenLimit?.() ?? 0;
      const weight = opts.cacheWeight?.();
      const rows = usage.summaryByUser().map((r) => ({
        ...r,
        // `used` becomes the billable total (cache hits discounted); raw input/output/cached kept.
        ...quotaView(
          billableTokens(r.used, r.cached, weight),
          effectiveLimit(r.tokenLimit, defaultLimit),
        ),
      }));
      return c.json({ users: rows, defaultLimit });
    });

    const limitBody = z.object({ limit: z.number().int().nonnegative().nullable() });
    app.put('/users/:id/limit', async (c) => {
      const parsed = await parseBody(c, limitBody, { message: 'invalid limit' });
      if (parsed instanceof Response) return parsed;
      if (!users.setTokenLimit(c.req.param('id'), parsed.limit)) {
        return c.json({ error: { code: 'not_found', message: 'no such user' } }, 404);
      }
      return c.json({ ok: true });
    });

    app.post('/users/:id/reset', (c) => {
      if (!users.resetUsage(c.req.param('id'))) {
        return c.json({ error: { code: 'not_found', message: 'no such user' } }, 404);
      }
      return c.json({ ok: true });
    });
  }

  return app;
}
