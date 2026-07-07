// Validation + secret helpers for the admin platform settings (spec 019). `llmSettingSchema` is the
// CANONICAL LLM-provider shape (spec 055 FR-374): the chat's `ServerDefault` type is derived from it,
// so adding a provider `kind` is a one-line edit to the enum below. The API key is write-only over the
// wire (masked on read, kept on empty write, never logged).

import { z } from 'zod';

export const LLM_SETTING_KEY = 'llm.default';
export const TOGGLES_SETTING_KEY = 'toggles';

/** Canonical stored value for the chat's default LLM provider; `chat/providers.ts` `ServerDefault`
 * derives from this (FR-374). */
export const llmSettingSchema = z.object({
  kind: z.enum(['openai-compatible', 'anthropic']),
  model: z.string().min(1),
  baseUrl: z.string().nullable().optional(),
  apiKey: z.string().nullable().optional(),
});
export type LlmSetting = z.infer<typeof llmSettingSchema>;

/** Platform toggles (extensible). */
export const togglesSchema = z
  .object({
    freshnessSloSeconds: z.number().int().positive().optional(),
    chatEnabled: z.boolean().optional(),
    // Default per-user chat-token quota; 0 (or unset) = unlimited. A user's own `token_limit` overrides.
    defaultTokenLimit: z.number().int().nonnegative().optional(),
    // Weight (0–1) at which cache-hit input tokens count toward the quota; unset = 0.1.
    cachedTokenWeight: z.number().min(0).max(1).optional(),
    // Max tokens the model may generate per answer; unset = built-in default (4096).
    maxOutputTokens: z.number().int().positive().optional(),
    // API metering (spec 028) — per-key/principal request rate limits + the data-API request quota.
    // Rates are requests/min (0 = unlimited); the quota is requests per window. Unset = the built-in
    // defaults in app.ts. A key's own `quota_limit` overrides the data quota.
    apiRateData: z.number().int().nonnegative().optional(),
    apiRateChat: z.number().int().nonnegative().optional(),
    apiQuotaData: z.number().int().nonnegative().optional(),
    apiQuotaWindowSec: z.number().int().positive().optional(),
  })
  .strict();
export type Toggles = z.infer<typeof togglesSchema>;

/** PUT /api/admin/settings body — any subset; the LLM apiKey is optional (empty = keep existing). */
export const settingsPutSchema = z
  .object({
    llm: llmSettingSchema.optional(),
    toggles: togglesSchema.optional(),
  })
  .strict();
export type SettingsPut = z.infer<typeof settingsPutSchema>;

/** Mask an API key for read responses — never return the raw value. */
export function maskApiKey(key: string | null | undefined): {
  apiKeyMasked: boolean;
  apiKeyHint: string | null;
} {
  if (!key) return { apiKeyMasked: false, apiKeyHint: null };
  return { apiKeyMasked: true, apiKeyHint: `••••${key.slice(-4)}` };
}

/** On write: an omitted/empty incoming key keeps the existing stored key. */
export function mergeSecret(
  incoming: string | null | undefined,
  existing: string | null | undefined,
): string | null {
  if (incoming === undefined || incoming === null || incoming === '') return existing ?? null;
  return incoming;
}
