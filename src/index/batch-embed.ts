import type { Embedder } from './embedder.ts';

/**
 * 002-batch-embedding — the PURE batcher (research.md R2). Owns batch chunking, the positional
 * length-check (FR-003), the single-text retry (FR-004), forced-single mode (FR-005), the
 * 429/5xx backoff wrapper (FR-009), and per-batch progress (FR-010). It returns vectors and
 * accounting — it writes NO DB state (no upsertEmbedding, no FTS, no index_failures). Persistence
 * is the caller's job in run-index.ts (T024), keeping this module fully coverable.
 */

/** A dataset and its composed embedding text. */
export interface EmbedPair {
  datasetId: string;
  text: string;
}

/** A dataset left un-embedded this run, with a §1.1-taxonomy reason. */
export interface NotEmbedded {
  datasetId: string;
  reason: string;
}

/** In-memory accounting for one batched-embed pass (data-model §4.1). */
export interface BatchEmbedResult {
  /** Datasets that got a vector this run. */
  embedded: number;
  /** EVERY embedder invocation, including retries and forced-single calls (round-2 Q3). */
  embedderRequests: number;
  /** Datasets excluded for empty composed text (FR-007). */
  skippedEmpty: number;
  /** Datasets still un-embedded after the single-text retry (FR-004). */
  failed: number;
  /** In-memory mirror of the persisted index_failures rows. */
  failures: NotEmbedded[];
}

/** Per-batch progress snapshot (FR-010). */
export interface BatchProgress {
  batchesDone: number;
  batchesTotal: number;
  embedded: number;
  embedderRequests: number;
  failed: number;
}

export interface EmbedBatchOptions {
  /** Injectable sleep seam — set to a 0-delay resolver in tests (FR-009, Principle VI). */
  delay?: (ms: number) => Promise<void>;
  /** Transient-retry budget per embedder invocation (default 4). */
  maxRetries?: number;
  /** Base backoff in ms before exponential growth (default 200). */
  baseDelayMs?: number;
  /** Jitter source in [0,1); injectable for determinism (default Math.random). */
  jitter?: () => number;
  /** Emitted once per batch as it completes (FR-010). */
  onProgress?: (p: BatchProgress) => void;
  /** Called as each {datasetId, vector} lands so the caller can persist it (R2). */
  onVector?: (v: { datasetId: string; vector: Float32Array }) => void;
}

/** Thrown when transient (429/5xx) retries exhaust the budget (FR-009). */
export class TransientExhaustedError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Embedder transient failure exhausted retry budget (HTTP ${status})`);
    this.name = 'TransientExhaustedError';
    this.status = status;
  }
}

export type EmbedErrorClass = { kind: 'transient'; status: number } | { kind: 'content' };

/**
 * Classify a thrown embedder error (FR-009, R4): HTTP 429 and 5xx are *transient* (retryable);
 * everything else — a length-mismatch ("returned N vectors"), an HTTP 4xx other than 429, or any
 * non-HTTP throw — is *content* (non-retryable), which falls to the FR-004 single-text retry.
 *
 * Classification is by the TYPED error's numeric `httpStatus` field (FR-363), never by parsing
 * `err.message`. An embedder signals an HTTP fault by throwing an error carrying `httpStatus`
 * (`EmbedderHttpError`, `src/lib/errors.ts`); rewording that error's human-readable message can no
 * longer silently degrade a 429/5xx into a permanent content failure (spec 054 SC-2). Throws with
 * no numeric `httpStatus` (length mismatches, network errors, non-Error throws) remain `content`.
 */
export function classifyEmbedError(err: unknown): EmbedErrorClass {
  const status = httpStatusOf(err);
  if (status === undefined) return { kind: 'content' };
  if (status === 429 || status >= 500) return { kind: 'transient', status };
  return { kind: 'content' };
}

/** The numeric `httpStatus` carried by a typed HTTP error (e.g. `EmbedderHttpError`), or undefined. */
function httpStatusOf(err: unknown): number | undefined {
  if (err !== null && typeof err === 'object' && 'httpStatus' in err) {
    const status = (err as { httpStatus?: unknown }).httpStatus;
    if (typeof status === 'number' && Number.isFinite(status)) return status;
  }
  return undefined;
}

interface RetryOptions {
  delay?: (ms: number) => Promise<void>;
  maxRetries?: number;
  baseDelayMs?: number;
  jitter?: () => number;
  /** Invoked once per actual embedder call so embedderRequests counts every invocation. */
  onRequest?: () => void;
}

const realDelay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wrap a single embedder invocation (FR-009): retry only TRANSIENT (429/5xx) responses with
 * exponential backoff + jitter up to `maxRetries`; rethrow a CONTENT fault immediately (so the
 * caller runs the FR-004 single-text retry); throw {@link TransientExhaustedError} when the
 * transient budget is exhausted. The `delay`/`jitter` seams are injectable (0-delay in tests).
 */
export async function embedWithRetry(
  embed: (texts: string[]) => Promise<Float32Array[]>,
  texts: string[],
  opts: RetryOptions = {},
): Promise<Float32Array[]> {
  const delay = opts.delay ?? realDelay;
  const maxRetries = opts.maxRetries ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 200;
  const jitter = opts.jitter ?? Math.random;
  let lastStatus = 0;
  for (let attempt = 0; ; attempt++) {
    opts.onRequest?.();
    try {
      return await embed(texts);
    } catch (err) {
      const cls = classifyEmbedError(err);
      if (cls.kind === 'content') throw err;
      lastStatus = cls.status;
      if (attempt >= maxRetries) throw new TransientExhaustedError(lastStatus);
      const wait = baseDelayMs * 2 ** attempt + jitter() * baseDelayMs;
      await delay(wait);
    }
  }
}

/**
 * Batch the non-empty {@link EmbedPair}s through `embedder` (FR-001). Empty/whitespace texts are
 * excluded (FR-007). Non-empty pairs are chunked into ≤ `effectiveBatchSize` groups embedded
 * SEQUENTIALLY (one in flight, FR-009). Each returned batch is asserted positionally
 * (`returned.length === input.length`, FR-003); on a mismatch/throw the whole batch falls to a
 * single-text retry (FR-004) recording only the still-failing pairs. When `effectiveBatchSize === 1`
 * the chunking is statically one-text-per-request (FR-005). Every invocation is counted in
 * `embedderRequests` (round-2 Q3). PURE: returns vectors via `onVector`; writes no DB state.
 */
export async function embedBatch(
  pairs: EmbedPair[],
  embedder: Embedder,
  effectiveBatchSize: number,
  options: EmbedBatchOptions = {},
): Promise<BatchEmbedResult> {
  const delay = options.delay ?? realDelay;
  const retryOpts = (onRequest: () => void): RetryOptions => ({
    delay,
    onRequest,
    ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
    ...(options.baseDelayMs !== undefined ? { baseDelayMs: options.baseDelayMs } : {}),
    ...(options.jitter !== undefined ? { jitter: options.jitter } : {}),
  });

  const result: BatchEmbedResult = {
    embedded: 0,
    embedderRequests: 0,
    skippedEmpty: 0,
    failed: 0,
    failures: [],
  };
  const countRequest = (): void => {
    result.embedderRequests++;
  };

  // FR-007: exclude empty/whitespace pairs up front (the caller pre-filters, but the batcher
  // also defends; an excluded pair is counted in skippedEmpty and recorded `empty_text`).
  const live: EmbedPair[] = [];
  for (const p of pairs) {
    if (p.text.trim() === '') {
      result.skippedEmpty++;
      result.failures.push({ datasetId: p.datasetId, reason: 'empty_text' });
    } else {
      live.push(p);
    }
  }

  const batches = chunk(live, effectiveBatchSize);
  const batchesTotal = batches.length;
  let batchesDone = 0;

  for (const batch of batches) {
    const texts = batch.map((p) => p.text);
    let vectors: Float32Array[] | null = null;
    try {
      const out = await embedWithRetry((t) => embedder.embed(t), texts, retryOpts(countRequest));
      // FR-003: positional length check. A count mismatch fails the WHOLE batch (→ FR-004).
      if (out.length === texts.length) {
        vectors = out;
      }
    } catch {
      // Transient-exhausted or content fault on the batch → fall to the single-text retry.
      vectors = null;
    }

    if (vectors) {
      for (let i = 0; i < batch.length; i++) {
        const pair = batch[i];
        const vector = vectors[i];
        if (pair && vector) {
          result.embedded++;
          options.onVector?.({ datasetId: pair.datasetId, vector });
        }
      }
    } else {
      await salvageAsSingles(batch, embedder, retryOpts(countRequest), result, options.onVector);
    }

    batchesDone++;
    options.onProgress?.({
      batchesDone,
      batchesTotal,
      embedded: result.embedded,
      embedderRequests: result.embedderRequests,
      failed: result.failed,
    });
  }

  return result;
}

/**
 * FR-004 salvage: retry each pair of a failed/short batch as a single-text request, recording only
 * the pairs that still fail. `single_text_failed:<detail>` for a content fault or a short single
 * response; `transient_exhausted:<status>` when the single retry exhausts the backoff budget.
 */
async function salvageAsSingles(
  batch: EmbedPair[],
  embedder: Embedder,
  retry: RetryOptions,
  result: BatchEmbedResult,
  onVector: EmbedBatchOptions['onVector'],
): Promise<void> {
  for (const pair of batch) {
    try {
      const out = await embedWithRetry((t) => embedder.embed(t), [pair.text], retry);
      const vector = out[0];
      if (out.length === 1 && vector) {
        result.embedded++;
        onVector?.({ datasetId: pair.datasetId, vector });
      } else {
        recordFailure(result, pair.datasetId, `single_text_failed:returned ${out.length} vectors`);
      }
    } catch (err) {
      if (err instanceof TransientExhaustedError) {
        recordFailure(result, pair.datasetId, `transient_exhausted:${err.status}`);
      } else {
        recordFailure(result, pair.datasetId, `single_text_failed:${errDetail(err)}`);
      }
    }
  }
}

function recordFailure(result: BatchEmbedResult, datasetId: string, reason: string): void {
  result.failed++;
  result.failures.push({ datasetId, reason });
}

function errDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
