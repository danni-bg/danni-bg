// Ordered embedder failover chain (spec 069). Wraps N embedders and serves `embed()` from the first
// that works, moving to the next only on a TRANSIENT fault (classifyEmbedError → transient: 429/5xx/
// network). A CONTENT fault (bad input / wrong dimension) fails everywhere, so it is rethrown rather
// than wasting the fallback. A tripped endpoint is skipped (breaker) for a cooldown so a sleeping box
// doesn't cost every call its timeout. The chain is homogeneous: every endpoint must be the SAME model
// (same vector space) — the constructor enforces equal `dimension`, and every returned vector is
// dimension-checked at runtime (the detectable half of vector-space drift; identical model is the
// operator's contract, spec 069 FR-501).

import { classifyEmbedError } from '../batch-embed.ts';
import type { Embedder } from '../embedder.ts';

interface Endpoint {
  embedder: Embedder;
  /** Epoch ms until which this endpoint is skipped after a transient failure (0 = healthy). */
  openUntil: number;
}

export class FailoverEmbedder implements Embedder {
  readonly id: string;
  readonly dimension: number;
  readonly maxBatchSize?: number;
  private readonly endpoints: Endpoint[];
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(embedders: Embedder[], opts: { cooldownMs?: number; now?: () => number } = {}) {
    if (embedders.length === 0) {
      throw new Error('FailoverEmbedder requires at least one embedder');
    }
    const first = embedders[0] as Embedder;
    // Homogeneity contract (FR-501): every endpoint must share the vector-space dimension.
    for (const e of embedders) {
      if (e.dimension !== first.dimension) {
        throw new Error(
          `embedder chain dimension mismatch: '${e.id}' is ${e.dimension}, expected ${first.dimension}`,
        );
      }
    }
    this.endpoints = embedders.map((embedder) => ({ embedder, openUntil: 0 }));
    // Stable identity (FR-503): report the PRIMARY's id + dimension so embeddings_meta doesn't thrash
    // on failover. maxBatchSize = the most restrictive cap across endpoints.
    this.id = first.id;
    this.dimension = first.dimension;
    const caps = embedders.map((e) => e.maxBatchSize).filter((c): c is number => c != null);
    if (caps.length > 0) this.maxBatchSize = Math.min(...caps);
    this.cooldownMs = opts.cooldownMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const t = this.now();
    // Healthy endpoints first; tripped ones only as a last resort (FR-502).
    const order = [
      ...this.endpoints.filter((e) => e.openUntil <= t),
      ...this.endpoints.filter((e) => e.openUntil > t),
    ];
    const errors: unknown[] = [];
    for (const ep of order) {
      try {
        const out = await ep.embedder.embed(texts);
        this.assertDimension(out, ep.embedder);
        ep.openUntil = 0; // recovered → close the breaker
        return out;
      } catch (err) {
        // A content fault (bad input, or the dimension guard above) fails on every endpoint — don't
        // burn the fallback on it; surface it.
        if (classifyEmbedError(err).kind === 'content') throw err;
        ep.openUntil = this.now() + this.cooldownMs; // transient → trip the breaker, try the next
        errors.push(err);
      }
    }
    throw new AggregateError(errors, `all ${this.endpoints.length} embedder endpoints failed`);
  }

  /** Guard against silent vector-space drift: a wrong-dimension result is a (content) hard error. */
  private assertDimension(out: Float32Array[], e: Embedder): void {
    const bad = out.find((v) => v.length !== this.dimension);
    if (bad) {
      throw new Error(
        `embedder '${e.id}' returned dimension ${bad.length}, expected ${this.dimension} — vector-space mismatch (wrong model?)`,
      );
    }
  }
}
