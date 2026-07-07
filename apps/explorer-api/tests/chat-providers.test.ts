import { describe, expect, it } from 'bun:test';
import type { z } from 'zod';
import type { llmSettingSchema } from '../src/admin/settings-schema.ts';
import {
  ProviderError,
  type ServerDefault,
  selectModel,
  serverDefaultFromEnv,
} from '../src/chat/providers.ts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;

describe('provider shape (spec 055 FR-374)', () => {
  it('ServerDefault kind is derived from the canonical llmSettingSchema enum (SC-4, type-level)', () => {
    // Adding a provider `kind` is a one-line edit to the schema's enum; this compiles only while the
    // two `kind` unions stay identical, so it fails to build the moment they diverge.
    type SchemaKind = z.infer<typeof llmSettingSchema>['kind'];
    const assertKindsEqual = (
      eq: Equal<ServerDefault['kind'], SchemaKind> extends true ? true : never,
    ) => eq;
    expect(assertKindsEqual(true)).toBe(true);
  });
});

describe('serverDefaultFromEnv', () => {
  it('returns null when provider or model is missing/invalid', () => {
    expect(serverDefaultFromEnv({})).toBeNull();
    expect(
      serverDefaultFromEnv({ EXPLORER_DEFAULT_PROVIDER: 'bogus', EXPLORER_DEFAULT_MODEL: 'm' }),
    ).toBeNull();
    expect(serverDefaultFromEnv({ EXPLORER_DEFAULT_PROVIDER: 'anthropic' })).toBeNull();
  });

  it('reads a complete config from env', () => {
    const d = serverDefaultFromEnv({
      EXPLORER_DEFAULT_PROVIDER: 'openai-compatible',
      EXPLORER_DEFAULT_MODEL: 'qwen',
      EXPLORER_DEFAULT_BASE_URL: 'http://spark:8889/v1',
      EXPLORER_DEFAULT_API_KEY: 'sk',
    });
    expect(d).toEqual({
      kind: 'openai-compatible',
      model: 'qwen',
      baseUrl: 'http://spark:8889/v1',
      apiKey: 'sk',
    });
  });
});

describe('selectModel', () => {
  // Spec 035 (FR-171): the ONLY input is the server-configured default — there is no per-request
  // provider parameter, so nothing request-derived can reach client construction.

  it('builds an openai-compatible model from the server default', () => {
    expect(
      selectModel({
        kind: 'openai-compatible',
        model: 'srv',
        baseUrl: 'http://x/v1',
        apiKey: 'k',
      }).modelId,
    ).toBe('srv');
  });

  it('builds an anthropic model from the server default (key optional)', () => {
    expect(selectModel({ kind: 'anthropic', model: 'claude' }).modelId).toBe('claude');
  });

  it('throws provider_unconfigured when no server default is configured', () => {
    try {
      selectModel(null);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError);
      expect((e as ProviderError).code).toBe('provider_unconfigured');
    }
  });
});
