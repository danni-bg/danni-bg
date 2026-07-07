import { EmbedderHttpError } from '../../lib/errors.ts';
import type { Embedder } from '../embedder.ts';

export interface HostedApiEmbedderOptions {
  endpointUrl: string;
  bearer?: string;
  fetcher?: typeof fetch;
  modelId?: string;
  dimension?: number;
  /** Provider hard per-request cap (FR-005); `=== 1` forces single-text mode in the batcher. */
  maxBatchSize?: number;
}

interface OpenAiEmbeddingResponse {
  data?: Array<{ embedding: number[] }>;
}

export class HostedApiEmbedder implements Embedder {
  readonly id: string;
  readonly dimension: number;
  readonly maxBatchSize?: number;
  private readonly endpoint: string;
  private readonly bearer?: string;
  private readonly fetcher: typeof fetch;
  private readonly modelId: string;

  constructor(opts: HostedApiEmbedderOptions) {
    this.endpoint = opts.endpointUrl;
    if (opts.bearer !== undefined) this.bearer = opts.bearer;
    this.fetcher = opts.fetcher ?? fetch;
    this.modelId = opts.modelId ?? 'unknown';
    this.id = `hosted-api:${this.modelId}`;
    this.dimension = opts.dimension ?? 384;
    if (opts.maxBatchSize !== undefined) this.maxBatchSize = opts.maxBatchSize;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.bearer) headers.authorization = `Bearer ${this.bearer}`;
    const res = await this.fetcher(this.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ input: texts, model: this.modelId }),
    });
    if (!res.ok) {
      // Carry the numeric status on a TYPED error (FR-362): the retry classifier switches on
      // `httpStatus`, not on this human-readable message — so wording is free to change without
      // silently downgrading 429/5xx backoff to a permanent content failure (spec 054 SC-2).
      throw new EmbedderHttpError(
        `Embedder ${this.endpoint} returned HTTP ${res.status}`,
        res.status,
      );
    }
    const body = (await res.json()) as OpenAiEmbeddingResponse;
    const data = body.data ?? [];
    if (data.length !== texts.length) {
      throw new Error(`Embedder returned ${data.length} vectors, expected ${texts.length}`);
    }
    const vectors = data.map((d) => Float32Array.from(d.embedding));
    // Fail loudly on a dimension mismatch rather than letting it degrade search silently:
    // cosine() returns 0 for vectors of differing length, so a wrong `dimension` config would
    // turn semantic ranking off without any error. The declared dimension is the contract.
    const got = vectors[0]?.length;
    if (got !== undefined && got !== this.dimension) {
      throw new Error(
        `Embedder returned ${got}-dim vectors but enrichment.embedder.dimension is ${this.dimension}; set dimension to ${got} to match the model`,
      );
    }
    return vectors;
  }
}
