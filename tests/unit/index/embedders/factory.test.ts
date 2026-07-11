import { afterEach, describe, expect, it } from 'bun:test';
import type { DanniConfig } from '../../../../src/config/schema.ts';
import { buildEmbedder } from '../../../../src/index/embedders/factory.ts';

type EmbCfg = DanniConfig['enrichment']['embedder'];

describe('index.embedders.factory buildEmbedder', () => {
  let origStderr: typeof process.stderr.write;
  afterEach(() => {
    if (origStderr) process.stderr.write = origStderr;
  });

  it('builds a HostedApiEmbedder threading id, dimension and maxBatchSize from config', () => {
    const e = buildEmbedder({
      provider: 'hosted-api',
      endpointUrl: 'https://api/embed',
      modelId: 'qwen3-embedding-8b',
      dimension: 4096,
      batchSize: 32,
      maxBatchSize: 64,
    } satisfies EmbCfg);
    expect(e.id).toBe('hosted-api:qwen3-embedding-8b');
    expect(e.dimension).toBe(4096);
    expect(e.maxBatchSize).toBe(64);
  });

  it('throws when hosted-api is missing endpointUrl', () => {
    expect(() =>
      buildEmbedder({ provider: 'hosted-api', modelId: 'x', batchSize: 32 } satisfies EmbCfg),
    ).toThrow(/endpointUrl/);
  });

  it('constructs hosted-api when a bearer env var is configured', () => {
    process.env.__TEST_EMB_KEY = 'secret';
    try {
      const e = buildEmbedder({
        provider: 'hosted-api',
        endpointUrl: 'https://api/embed',
        apiKeyEnv: '__TEST_EMB_KEY',
        batchSize: 32,
      } satisfies EmbCfg);
      expect(e.id).toBe('hosted-api:unknown');
    } finally {
      process.env.__TEST_EMB_KEY = undefined;
    }
  });

  it('builds a local-onnx stub with the configured dimension and warns on stderr', () => {
    let warned = '';
    origStderr = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      warned += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as typeof process.stderr.write;
    const e = buildEmbedder({
      provider: 'local-onnx',
      dimension: 128,
      batchSize: 32,
    } satisfies EmbCfg);
    process.stderr.write = origStderr;
    expect(e.id).toBe('local-onnx:hash-stub-32');
    expect(e.dimension).toBe(128);
    expect(warned).toContain('hash stub');
  });

  it('wraps primary + fallbacks in a FailoverEmbedder when a chain is configured (spec 069)', () => {
    const e = buildEmbedder({
      provider: 'hosted-api',
      endpointUrl: 'http://spark:8889/v1/embeddings',
      modelId: 'qwen3-embedding-8b',
      dimension: 4096,
      batchSize: 32,
      fallbacks: [
        {
          provider: 'hosted-api',
          endpointUrl: 'https://api.scaleway.ai/v1/embeddings',
          modelId: 'qwen3-embedding-8b',
          dimension: 4096,
          batchSize: 32,
        },
      ],
    } satisfies EmbCfg);
    expect(e.constructor.name).toBe('FailoverEmbedder');
    expect(e.id).toBe('hosted-api:qwen3-embedding-8b'); // stable identity = primary
    expect(e.dimension).toBe(4096);
  });

  it('rejects a chain whose fallback declares a different dimension (homogeneity contract)', () => {
    expect(() =>
      buildEmbedder({
        provider: 'hosted-api',
        endpointUrl: 'http://spark:8889/v1/embeddings',
        dimension: 4096,
        batchSize: 32,
        fallbacks: [
          { provider: 'hosted-api', endpointUrl: 'https://api/x', dimension: 384, batchSize: 32 },
        ],
      } satisfies EmbCfg),
    ).toThrow(/dimension mismatch/);
  });
});
