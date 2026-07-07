// Provider seam (T046/T053, locked down in spec 035). Selects an AI SDK language model from the
// SERVER-configured default only — admin runtime settings (spec 019) with the EXPLORER_DEFAULT_* env
// as fallback: any OpenAI-compatible endpoint (configurable baseURL — covers OpenAI + self-hosted
// vLLM) or Anthropic. Nothing request-derived ever reaches client construction (FR-171) — a
// client-supplied provider would make the server an egress/SSRF proxy. The apiKey is used only to
// construct the client and is never logged or persisted (FR-024). A missing default surfaces as a
// typed ProviderError so the route can emit a clean SSE `error` event with no fabricated content
// (FR-023/FR-173).

import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { z } from 'zod';
import type { llmSettingSchema } from '../admin/settings-schema.ts';

/**
 * The resolved chat-provider default. Derived from the canonical `llmSettingSchema` (spec 055 FR-374)
 * so the provider shape has ONE definition: the schema's `nullable` `baseUrl`/`apiKey` map to plain
 * optionals here. Adding a provider `kind` is a one-line edit to the schema's `kind` enum — this type
 * (and everything typed by it) follows automatically.
 */
export type ServerDefault = {
  [K in keyof z.infer<typeof llmSettingSchema>]: Exclude<z.infer<typeof llmSettingSchema>[K], null>;
};

export type ProviderErrorCode = 'provider_unconfigured' | 'provider_error';

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** Read the server-default provider from the environment, or null when none is configured. */
export function serverDefaultFromEnv(env: NodeJS.ProcessEnv = process.env): ServerDefault | null {
  const kind = env.EXPLORER_DEFAULT_PROVIDER;
  if (kind !== 'openai-compatible' && kind !== 'anthropic') return null;
  const model = env.EXPLORER_DEFAULT_MODEL;
  if (!model) return null;
  return {
    kind,
    model,
    baseUrl: env.EXPLORER_DEFAULT_BASE_URL,
    apiKey: env.EXPLORER_DEFAULT_API_KEY,
  };
}

function build(
  kind: 'openai-compatible' | 'anthropic',
  model: string,
  baseUrl?: string,
  apiKey?: string,
): LanguageModelV3 {
  if (kind === 'anthropic') {
    return createAnthropic({
      ...(apiKey ? { apiKey } : {}),
      ...(baseUrl ? { baseURL: baseUrl } : {}),
    })(model);
  }
  return createOpenAI({
    ...(apiKey ? { apiKey } : {}),
    ...(baseUrl ? { baseURL: baseUrl } : {}),
  }).chat(model);
}

/**
 * Resolve the language model for a chat turn from the server-configured default ONLY (FR-171).
 * There is deliberately no per-request config parameter: the request body must never influence
 * which endpoint the server talks to.
 */
export function selectModel(serverDefault: ServerDefault | null): LanguageModelV3 {
  if (!serverDefault) {
    throw new ProviderError('provider_unconfigured', 'no server default provider is configured');
  }
  return build(
    serverDefault.kind,
    serverDefault.model,
    serverDefault.baseUrl,
    serverDefault.apiKey,
  );
}
