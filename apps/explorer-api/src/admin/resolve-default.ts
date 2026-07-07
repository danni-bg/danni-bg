// Resolve the chat's default LLM provider at request time (spec 019): the settings store wins, else
// the EXPLORER_DEFAULT_* env (the seed/fallback), else null (→ the existing provider_unconfigured
// error). Pure + synchronous so it can run per request and be unit-tested without a live anything.

import {
  GLOBAL_SETTINGS,
  type PlatformSettingsRepo,
} from '../../../../src/store/repos/platform-settings.ts';
import { type ServerDefault, serverDefaultFromEnv } from '../chat/providers.ts';
import { LLM_SETTING_KEY, llmSettingSchema } from './settings-schema.ts';

// `tenantId` (spec 042 FR-240): resolve the LLM default through the caller's active org — the
// tenant's own override wins, the `global` row remains the fallback (`settings.get` semantics). The
// default (`global`) keeps every existing single-tenant call site unchanged (FR-245).
export function resolveServerDefault(
  settings: PlatformSettingsRepo,
  env: NodeJS.ProcessEnv = process.env,
  tenantId: string = GLOBAL_SETTINGS,
): ServerDefault | null {
  const raw = settings.get(LLM_SETTING_KEY, tenantId);
  if (raw != null) {
    const v = llmSettingSchema.parse(raw);
    return {
      kind: v.kind,
      model: v.model,
      baseUrl: v.baseUrl ?? undefined,
      apiKey: v.apiKey ?? undefined,
    };
  }
  return serverDefaultFromEnv(env);
}
