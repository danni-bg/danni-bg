// Per-tenant runtime settings (spec 042). Migration 017 made `platform_settings` (tenant_id, key)
// with a `global` fallback, but every caller read/wrote only the global row. This wires the existing
// capability through the active org and gives org admins a management surface for their OWN org — with
// an explicit allowlist of which keys a tenant may override and a hard no-cross-tenant-secret-leak rule
// (FR-243): a tenant-facing response never carries another tenant's or the global row's secret.

import { z } from 'zod';
import {
  GLOBAL_SETTINGS,
  type PlatformSettingsRepo,
} from '../../../../src/store/repos/platform-settings.ts';
import { resolveServerDefault } from './resolve-default.ts';
import {
  LLM_SETTING_KEY,
  type LlmSetting,
  TOGGLES_SETTING_KEY,
  llmSettingSchema,
  maskApiKey,
  mergeSecret,
} from './settings-schema.ts';

/**
 * The ONLY `platform_settings` keys a tenant may override on its own row (FR-241), defined in one
 * place. The LLM provider is tenant policy; `defaultTokenLimit` is stored inside the toggles blob but
 * is the sole toggle field a tenant may set — the management schema below rejects every other toggle
 * (`apiRate*`/`apiQuota*` + platform-wide switches stay deployment-global). A key absent from this set
 * always resolves to the global row and can never be set per-tenant.
 */
export const TENANT_OVERRIDABLE_KEYS = [LLM_SETTING_KEY, TOGGLES_SETTING_KEY] as const;

/**
 * PUT body for the tenant/super-admin management surface (FR-242): org admins may set or clear ONLY
 * the allowlisted overrides. `.strict()` rejects any other field — so overriding a platform toggle or
 * an api rate/quota knob per-tenant is a 400 that writes nothing (SC-3). For each field: a value sets
 * the override, `null` clears it (falls back to global), omission leaves it as-is. The LLM apiKey is
 * write-only (empty/omitted = keep the tenant's OWN existing key, never inherit the global one).
 */
export const tenantSettingsPutSchema = z
  .object({
    llm: llmSettingSchema.nullable().optional(),
    defaultTokenLimit: z.number().int().nonnegative().nullable().optional(),
  })
  .strict();
export type TenantSettingsPut = z.infer<typeof tenantSettingsPutSchema>;

/** Non-secret view of a tenant's LLM setting. Never contains a secret or a derivable hint of the
 * global/another tenant's key: for the tenant's OWN override the last-4 hint of THEIR key is fine;
 * for an inherited config only `apiKeyConfigured` (a boolean) is exposed, never a hint (FR-243). */
export interface TenantLlmView {
  overridden: boolean;
  source: 'tenant' | 'inherited';
  kind: string;
  model: string;
  baseUrl: string | null;
  apiKeyConfigured: boolean;
  apiKeyHint: string | null;
}

export interface TenantSettingsView {
  llm: TenantLlmView | null;
  // `defaultTokenLimit` is not a secret: showing the inherited (global) value is intentional so an
  // admin sees what their org effectively gets. `overridden` distinguishes an org-set value.
  defaultTokenLimit: { overridden: boolean; value: number | null };
}

function ownToggles(
  settings: PlatformSettingsRepo,
  tenantId: string,
): { defaultTokenLimit?: number } {
  const raw = settings.own(TOGGLES_SETTING_KEY, tenantId);
  return raw && typeof raw === 'object' ? (raw as { defaultTokenLimit?: number }) : {};
}

/** The tenant-facing settings view — masked, isolation-safe. */
export function tenantSettingsView(
  settings: PlatformSettingsRepo,
  tenantId: string,
  env: NodeJS.ProcessEnv = process.env,
): TenantSettingsView {
  const ownLlm = settings.own(LLM_SETTING_KEY, tenantId) as LlmSetting | null;
  let llm: TenantLlmView | null;
  if (ownLlm) {
    const v = llmSettingSchema.parse(ownLlm);
    llm = {
      overridden: true,
      source: 'tenant',
      kind: v.kind,
      model: v.model,
      baseUrl: v.baseUrl ?? null,
      apiKeyConfigured: Boolean(v.apiKey),
      // The tenant's OWN key — a last-4 hint of their own secret is fine.
      apiKeyHint: maskApiKey(v.apiKey).apiKeyHint,
    };
  } else {
    // Inherited: describe the effective global/env config's NON-secret fields only — never its key or
    // a hint of it. `apiKeyConfigured` says a key exists; the value/hint stays server-side (FR-243).
    const eff = resolveServerDefault(settings, env, GLOBAL_SETTINGS);
    llm = eff
      ? {
          overridden: false,
          source: 'inherited',
          kind: eff.kind,
          model: eff.model,
          baseUrl: eff.baseUrl ?? null,
          apiKeyConfigured: Boolean(eff.apiKey),
          apiKeyHint: null,
        }
      : null;
  }

  const own = ownToggles(settings, tenantId);
  const overriddenLimit = typeof own.defaultTokenLimit === 'number';
  // Effective value: tenant override if set, else the global toggles value (non-secret).
  const globalToggles = settings.get(TOGGLES_SETTING_KEY, GLOBAL_SETTINGS) as {
    defaultTokenLimit?: number;
  } | null;
  const value = overriddenLimit
    ? (own.defaultTokenLimit as number)
    : (globalToggles?.defaultTokenLimit ?? null);

  return { llm, defaultTokenLimit: { overridden: overriddenLimit, value } };
}

/**
 * Apply an org admin's (or super-admin's) settings write to a tenant's overrides. Only the allowlisted
 * keys are touched. A secret is merged against the tenant's OWN prior value (never the global one), so
 * an admin can never inherit or derive the global key by omitting it (FR-243). The tenant toggles row
 * intentionally holds ONLY `defaultTokenLimit` — the sole overridable toggle field.
 */
export function applyTenantSettings(
  settings: PlatformSettingsRepo,
  tenantId: string,
  body: TenantSettingsPut,
  updatedBy: string | null,
): void {
  if (body.llm === null) {
    settings.clear(LLM_SETTING_KEY, tenantId);
  } else if (body.llm) {
    const existing = settings.own(LLM_SETTING_KEY, tenantId) as LlmSetting | null;
    const merged: LlmSetting = {
      kind: body.llm.kind,
      model: body.llm.model,
      baseUrl: body.llm.baseUrl ?? null,
      apiKey: mergeSecret(body.llm.apiKey, existing?.apiKey),
    };
    settings.set(LLM_SETTING_KEY, merged, updatedBy, undefined, tenantId);
  }

  if (body.defaultTokenLimit === null) {
    // Clearing the sole overridable toggle field removes the tenant toggles row (it holds nothing else).
    settings.clear(TOGGLES_SETTING_KEY, tenantId);
  } else if (body.defaultTokenLimit !== undefined) {
    settings.set(
      TOGGLES_SETTING_KEY,
      { defaultTokenLimit: body.defaultTokenLimit },
      updatedBy,
      undefined,
      tenantId,
    );
  }
}

/** Clear every overridable key for a tenant — the super-admin recovery path (FR-244). */
export function clearTenantSettings(settings: PlatformSettingsRepo, tenantId: string): void {
  for (const key of TENANT_OVERRIDABLE_KEYS) settings.clear(key, tenantId);
}
