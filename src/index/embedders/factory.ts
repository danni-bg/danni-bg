import type { DanniConfig } from '../../config/schema.ts';
import type { Embedder } from '../embedder.ts';
import { FailoverEmbedder } from './failover.ts';
import { HostedApiEmbedder } from './hosted-api.ts';
import { LocalOnnxEmbedder } from './local-onnx.ts';

type EmbedderConfig = DanniConfig['enrichment']['embedder'];

/** Build ONE embedder endpoint (the primary or a failover entry). */
function buildSingle(e: EmbedderConfig): Embedder {
  if (e.provider === 'hosted-api') {
    if (!e.endpointUrl) throw new Error('embedder.endpointUrl is required for hosted-api');
    const bearer = e.apiKeyEnv ? process.env[e.apiKeyEnv] : undefined;
    return new HostedApiEmbedder({
      endpointUrl: e.endpointUrl,
      ...(bearer ? { bearer } : {}),
      ...(e.modelId ? { modelId: e.modelId } : {}),
      ...(e.dimension != null ? { dimension: e.dimension } : {}),
      ...(e.maxBatchSize != null ? { maxBatchSize: e.maxBatchSize } : {}),
    });
  }
  const embedder = new LocalOnnxEmbedder({
    ...(e.modelId ? { modelId: e.modelId } : {}),
    ...(e.dimension != null ? { dimension: e.dimension } : {}),
  });
  if (embedder.isStub) {
    process.stderr.write(
      `warning: embedder provider 'local-onnx' is a deterministic hash stub (${embedder.id}) — semantic ranking is NOT meaningful; only the FTS/keyword leg is real. Set enrichment.embedder.provider='hosted-api' for genuine semantic vectors.\n`,
    );
  }
  return embedder;
}

/**
 * Build the configured embedder, shared by `danni index`, `danni search`, `danni eval`, and the read
 * bridge so they never drift on provider selection. `hosted-api` targets any OpenAI-compatible
 * `/embeddings` endpoint; `local-onnx` is a deterministic hash stub unless a real `embedFn` is
 * injected (loud stderr warning). When `fallbacks` are configured (spec 069) the primary + fallbacks
 * are wrapped in a `FailoverEmbedder` — an ordered chain that serves from the first working endpoint;
 * the wrapper's constructor rejects a chain whose endpoints declare unequal `dimension` (the
 * homogeneity contract). No fallbacks → the single embedder exactly as before.
 */
export function buildEmbedder(e: EmbedderConfig): Embedder {
  const primary = buildSingle(e);
  if (!e.fallbacks || e.fallbacks.length === 0) return primary;
  return new FailoverEmbedder([primary, ...e.fallbacks.map((f) => buildSingle(f))]);
}
