// Admin platform settings API (spec 019), under requireAuth + requireAdmin. GET returns the current
// settings with the LLM API key MASKED (never raw); PUT validates + persists, treating an empty key
// as "keep existing". The chat's default provider is resolved from these settings per request.

import { Hono } from 'hono';
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
import type { SessionResolver } from '../auth/kratos-session.ts';
import { serverDefaultFromEnv } from '../chat/providers.ts';
import { billableTokens, effectiveLimit, quotaView } from '../chat/quota.ts';
import { type AuthEnv, requireAdmin, requireAuth } from '../middleware/require-auth.ts';

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
  sessionResolver?: SessionResolver | undefined;
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

export function adminRoutes(
  users: UsersRepo,
  settings: PlatformSettingsRepo,
  opts: AdminRoutesOpts = {},
): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  // Pass apiKeys so a key authenticates then requireAdmin cleanly 403s it (keys are never admin).
  app.use('*', requireAuth(users, opts.sessionResolver, opts.apiKeys, opts.tenants), requireAdmin);

  app.get('/settings', (c) => {
    const { source, llm } = maskedLlm(settings);
    return c.json({ llm, toggles: togglesView(settings), source });
  });

  app.put('/settings', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: 'bad_request', message: 'invalid JSON body' } }, 400);
    }
    const parsed = settingsPutSchema.safeParse(body);
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
    const by = c.get('user').email;
    if (parsed.data.llm) {
      const existing = settings.get(LLM_SETTING_KEY) as LlmSetting | null;
      const merged: LlmSetting = {
        kind: parsed.data.llm.kind,
        model: parsed.data.llm.model,
        baseUrl: parsed.data.llm.baseUrl ?? null,
        apiKey: mergeSecret(parsed.data.llm.apiKey, existing?.apiKey),
      };
      settings.set(LLM_SETTING_KEY, merged, by);
    }
    if (parsed.data.toggles) settings.set(TOGGLES_SETTING_KEY, parsed.data.toggles, by);
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

  // Super-admin org management (spec 029 FR-132): list every org + create a new one. Reviewed for
  // spec 036 FR-183: no member/role mutations are exposed here, so the zero-owner invariant
  // (FR-182) cannot be violated from this surface; any future member mutation added here may bypass
  // the owner-CALLER rule (a platform admin outranks org owners) but must keep ≥1 owner per org.
  if (tenants) {
    app.get('/tenants', (c) => c.json({ tenants: tenants.listAll() }));
    app.post('/tenants', async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: { code: 'bad_request', message: 'invalid JSON body' } }, 400);
      }
      const parsed = createTenantBody.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: { code: 'bad_request', message: 'invalid org' } }, 400);
      }
      if (tenants.getBySlug(parsed.data.slug)) {
        return c.json({ error: { code: 'conflict', message: 'slug already in use' } }, 409);
      }
      const created = tenants.create({
        name: parsed.data.name,
        slug: parsed.data.slug,
        ...(parsed.data.plan ? { plan: parsed.data.plan } : {}),
      });
      return c.json(created, 201);
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
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: { code: 'bad_request', message: 'invalid JSON body' } }, 400);
      }
      const parsed = limitBody.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: { code: 'bad_request', message: 'invalid limit' } }, 400);
      }
      if (!users.setTokenLimit(c.req.param('id'), parsed.data.limit)) {
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
