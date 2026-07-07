import { describe, expect, it } from 'bun:test';
import {
  TransientExhaustedError,
  classifyEmbedError,
  embedBatch,
  embedWithRetry,
} from '../../../src/index/batch-embed.ts';
import type { Embedder } from '../../../src/index/embedder.ts';
import { EmbedderHttpError } from '../../../src/lib/errors.ts';

/** A typed HTTP fault as an embedder produces it (FR-362); classification switches on `httpStatus`. */
function httpError(status: number, message = `Embedder https://api/x returned HTTP ${status}`) {
  return new EmbedderHttpError(message, status);
}

/** Zero-delay seam so the suite stays < 5s (Principle VI). Records the backoff args it was given. */
function recordingDelay(): { delay: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    delay: (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    },
  };
}

// --- T012: the transient-retry / backoff wrapper -------------------------------------------

describe('index.batch-embed embedWithRetry (T012, FR-009)', () => {
  it('retries a 429 then succeeds on the next attempt', async () => {
    let n = 0;
    const embed = (texts: string[]): Promise<Float32Array[]> => {
      n++;
      if (n === 1) throw httpError(429);
      return Promise.resolve(texts.map(() => Float32Array.from([1])));
    };
    const { delay } = recordingDelay();
    const out = await embedWithRetry(embed, ['a'], { delay });
    expect(out.length).toBe(1);
    expect(n).toBe(2);
  });

  it('retries a 5xx then succeeds', async () => {
    let n = 0;
    const embed = (texts: string[]): Promise<Float32Array[]> => {
      n++;
      if (n === 1) throw httpError(503);
      return Promise.resolve(texts.map(() => Float32Array.from([1])));
    };
    const { delay } = recordingDelay();
    await embedWithRetry(embed, ['a'], { delay });
    expect(n).toBe(2);
  });

  it('does NOT retry a content (length-mismatch) fault — it rethrows immediately', async () => {
    let n = 0;
    const embed = (): Promise<Float32Array[]> => {
      n++;
      throw new Error('Embedder returned 1 vectors, expected 2');
    };
    const { delay } = recordingDelay();
    await expect(embedWithRetry(embed, ['a', 'b'], { delay })).rejects.toThrow(
      /returned 1 vectors/,
    );
    expect(n).toBe(1);
  });

  it('rethrows a TransientExhaustedError carrying the status when the budget is exhausted', async () => {
    const embed = (): Promise<Float32Array[]> => {
      throw httpError(429);
    };
    const { delay } = recordingDelay();
    let caught: unknown;
    try {
      await embedWithRetry(embed, ['a'], { delay, maxRetries: 2 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TransientExhaustedError);
    expect((caught as TransientExhaustedError).status).toBe(429);
  });

  it('calls the injected delay with growing (exponential) backoff arguments', async () => {
    const embed = (): Promise<Float32Array[]> => {
      throw httpError(500);
    };
    const { delay, waits } = recordingDelay();
    await expect(
      embedWithRetry(embed, ['a'], { delay, maxRetries: 3, baseDelayMs: 10, jitter: () => 0 }),
    ).rejects.toBeInstanceOf(TransientExhaustedError);
    expect(waits.length).toBe(3);
    expect(waits[1]).toBeGreaterThan(waits[0] ?? 0);
    expect(waits[2]).toBeGreaterThan(waits[1] ?? 0);
  });

  it('adds jitter to each backoff wait', async () => {
    const embed = (): Promise<Float32Array[]> => {
      throw httpError(500);
    };
    const { delay, waits } = recordingDelay();
    await expect(
      embedWithRetry(embed, ['a'], { delay, maxRetries: 1, baseDelayMs: 10, jitter: () => 0.5 }),
    ).rejects.toBeInstanceOf(TransientExhaustedError);
    // base 10 * 2^0 = 10, plus jitter 0.5*10 = 5 → 15
    expect(waits[0]).toBe(15);
  });

  it('rethrows a non-HTTP error unchanged (not transient)', async () => {
    const embed = (): Promise<Float32Array[]> => {
      throw new Error('network down');
    };
    const { delay } = recordingDelay();
    await expect(embedWithRetry(embed, ['a'], { delay })).rejects.toThrow(/network down/);
  });

  it('uses the real (default) timer when no delay is injected (0ms base → fast)', async () => {
    let n = 0;
    const embed = (texts: string[]): Promise<Float32Array[]> => {
      n++;
      if (n === 1) throw httpError(429);
      return Promise.resolve(texts.map(() => Float32Array.from([1])));
    };
    // No `delay` → exercises the default realDelay seam; baseDelayMs 0 keeps it instant.
    const out = await embedWithRetry(embed, ['a'], { baseDelayMs: 0, jitter: () => 0 });
    expect(out.length).toBe(1);
    expect(n).toBe(2);
  });
});

describe('index.batch-embed classifyEmbedError (T012, spec 054 FR-363)', () => {
  it('classifies a typed HTTP 429/5xx error as transient with its status', () => {
    expect(classifyEmbedError(httpError(429))).toEqual({ kind: 'transient', status: 429 });
    expect(classifyEmbedError(httpError(500))).toEqual({ kind: 'transient', status: 500 });
    expect(classifyEmbedError(httpError(503))).toEqual({ kind: 'transient', status: 503 });
  });

  it('classifies a typed HTTP 4xx (non-429) error as content (non-retryable)', () => {
    expect(classifyEmbedError(httpError(400))).toEqual({ kind: 'content' });
    expect(classifyEmbedError(httpError(401))).toEqual({ kind: 'content' });
  });

  it('classifies a length-mismatch (untyped) as content', () => {
    expect(classifyEmbedError(new Error('Embedder returned 1 vectors, expected 2'))).toEqual({
      kind: 'content',
    });
  });

  it('classifies a non-Error / non-HTTP throw as content', () => {
    expect(classifyEmbedError('boom')).toEqual({ kind: 'content' });
    expect(classifyEmbedError(new Error('something else'))).toEqual({ kind: 'content' });
  });

  it('classifies by the typed status field, NOT the message — a reworded 503 still backs off', () => {
    // The regression spec 054 FR-363/SC-2 calls out: the classifier reads `httpStatus`, not the
    // message. A message with no "HTTP NNN" text (or a misleading one) does not degrade a real
    // 503 into a permanent content failure, nor promote a content fault into a transient retry.
    expect(classifyEmbedError(httpError(503, 'service unavailable, please retry'))).toEqual({
      kind: 'transient',
      status: 503,
    });
    expect(
      classifyEmbedError(httpError(400, 'bad request — HTTP 500 mentioned but not the cause')),
    ).toEqual({ kind: 'content' });
    // An untyped error whose message merely CONTAINS "HTTP 429" is no longer mistaken for transient.
    expect(classifyEmbedError(new Error('log line: upstream returned HTTP 429 earlier'))).toEqual({
      kind: 'content',
    });
  });
});

// --- The recording embedder used across the batcher-core tests -----------------------------

interface RecOpts {
  dimension?: number;
  maxBatchSize?: number;
  /** Per-call hook to mutate the returned vectors or throw (drives short/reorder/429 cases). */
  hook?: (texts: string[], callIndex: number, vectors: Float32Array[]) => Float32Array[] | never;
}

class RecordingEmbedder implements Embedder {
  readonly id = 'rec:stub';
  readonly dimension: number;
  readonly maxBatchSize?: number;
  readonly calls: string[][] = [];
  private readonly hook?: RecOpts['hook'];

  constructor(opts: RecOpts = {}) {
    this.dimension = opts.dimension ?? 4;
    if (opts.maxBatchSize !== undefined) this.maxBatchSize = opts.maxBatchSize;
    this.hook = opts.hook;
  }

  embed(texts: string[]): Promise<Float32Array[]> {
    const callIndex = this.calls.length;
    this.calls.push([...texts]);
    const vectors = texts.map((t) => vec(t, this.dimension));
    if (this.hook) return Promise.resolve(this.hook(texts, callIndex, vectors));
    return Promise.resolve(vectors);
  }
}

/** Deterministic per-text vector (pure function of the text — output-equivalence by construction). */
function vec(text: string, dim: number): Float32Array {
  const v = new Float32Array(dim);
  for (let i = 0; i < text.length; i++) v[i % dim] = (v[i % dim] ?? 0) + text.charCodeAt(i);
  return v;
}

function pairs(n: number): Array<{ datasetId: string; text: string }> {
  return Array.from({ length: n }, (_, i) => ({ datasetId: `d${i}`, text: `text-${i}` }));
}

const ZERO_DELAY = (): Promise<void> => Promise.resolve();

// --- T014: chunking + happy-path request count ---------------------------------------------

describe('index.batch-embed embedBatch chunking (T014, SC-001)', () => {
  it('issues ceil(N/B) requests, each carrying <= B texts, embeds all (exact divisor)', async () => {
    const e = new RecordingEmbedder();
    const ps = pairs(8);
    const got: Array<{ datasetId: string; vector: Float32Array }> = [];
    const r = await embedBatch(ps, e, 4, { delay: ZERO_DELAY, onVector: (v) => got.push(v) });
    expect(e.calls.length).toBe(2); // ceil(8/4)
    expect(e.calls.every((c) => c.length <= 4)).toBe(true);
    expect(r.embedded).toBe(8);
    expect(r.embedderRequests).toBe(2);
    expect(r.failed).toBe(0);
    expect(r.failures).toEqual([]);
    expect(r.skippedEmpty).toBe(0);
    expect(got.length).toBe(8);
  });

  it('includes a final partial batch when N % B !== 0', async () => {
    const e = new RecordingEmbedder();
    const r = await embedBatch(pairs(10), e, 4, { delay: ZERO_DELAY });
    expect(e.calls.length).toBe(3); // ceil(10/4) = 3 (4,4,2)
    expect(e.calls[2]?.length).toBe(2);
    expect(r.embedderRequests).toBe(3);
    expect(r.embedded).toBe(10);
  });

  it('handles a single-element set (one batch of one)', async () => {
    const e = new RecordingEmbedder();
    const r = await embedBatch(pairs(1), e, 32, { delay: ZERO_DELAY });
    expect(e.calls.length).toBe(1);
    expect(r.embedded).toBe(1);
  });

  it('handles an empty set (no requests, all zero)', async () => {
    const e = new RecordingEmbedder();
    const r = await embedBatch([], e, 32, { delay: ZERO_DELAY });
    expect(e.calls.length).toBe(0);
    expect(r).toEqual({
      embedded: 0,
      embedderRequests: 0,
      skippedEmpty: 0,
      failed: 0,
      failures: [],
    });
  });

  it('uses default options (no delay/seams injected) on the happy path', async () => {
    const e = new RecordingEmbedder();
    const r = await embedBatch(pairs(3), e, 2);
    expect(r.embedded).toBe(3);
    expect(r.embedderRequests).toBe(2);
  });
});

// --- T015: empty-text exclusion ------------------------------------------------------------

describe('index.batch-embed empty-text exclusion (T015, FR-007)', () => {
  it('excludes empty/whitespace pairs, counts skippedEmpty, records empty_text', async () => {
    const e = new RecordingEmbedder();
    const ps = [
      { datasetId: 'a', text: 'real' },
      { datasetId: 'b', text: '' },
      { datasetId: 'c', text: '   ' },
      { datasetId: 'd', text: 'also-real' },
    ];
    const r = await embedBatch(ps, e, 4, { delay: ZERO_DELAY });
    // only 2 non-empty texts sent
    expect(e.calls.flat()).toEqual(['real', 'also-real']);
    expect(r.skippedEmpty).toBe(2);
    expect(r.embedded).toBe(2);
    const empties = r.failures.filter((f) => f.reason === 'empty_text').map((f) => f.datasetId);
    expect(empties.sort()).toEqual(['b', 'c']);
  });

  it('chunks the remaining non-empty pairs into ceil((N-empty)/B) batches', async () => {
    const e = new RecordingEmbedder();
    const ps = [...pairs(5), { datasetId: 'empty', text: '' }];
    const r = await embedBatch(ps, e, 2, { delay: ZERO_DELAY });
    expect(e.calls.length).toBe(3); // ceil(5/2)
    expect(r.skippedEmpty).toBe(1);
    expect(r.embedded).toBe(5);
  });
});

// --- T016: positional length-check → fail-whole-batch → single-text retry -------------------

describe('index.batch-embed length-check + single-text salvage (T016, FR-003/FR-004, SC-004)', () => {
  it('a short-returning batch fails the length check and salvages each pair as a single', async () => {
    const e = new RecordingEmbedder({
      hook: (texts, callIndex, vectors) => {
        // First call is the full batch of 3 → drop one vector to short-return.
        if (callIndex === 0) return vectors.slice(0, texts.length - 1);
        return vectors;
      },
    });
    const r = await embedBatch(pairs(3), e, 3, { delay: ZERO_DELAY });
    // 1 failed batch + 3 single-text retries
    expect(r.embedderRequests).toBe(4);
    expect(r.embedded).toBe(3);
    expect(r.failed).toBe(0);
  });

  it('only the genuinely-failing single pair lands in failed + single_text_failed', async () => {
    const e = new RecordingEmbedder({
      hook: (texts, callIndex, vectors) => {
        if (callIndex === 0) return vectors.slice(0, texts.length - 1); // short the batch
        // On single-text retries, dataset d1 always short-returns (a real per-text fault).
        if (texts[0] === 'text-1') return [];
        return vectors;
      },
    });
    const r = await embedBatch(pairs(3), e, 3, { delay: ZERO_DELAY });
    expect(r.embedded).toBe(2);
    expect(r.failed).toBe(1);
    expect(r.failures.length).toBe(1);
    expect(r.failures[0]?.datasetId).toBe('d1');
    expect(r.failures[0]?.reason).toMatch(/^single_text_failed:/);
  });

  it('records single_text_failed with the thrown content detail (Error and non-Error rejections)', async () => {
    let callIndex = 0;
    const e: Embedder = {
      id: 'rejector',
      dimension: 4,
      embed: (texts: string[]): Promise<Float32Array[]> => {
        const ci = callIndex++;
        if (ci === 0) return Promise.reject(new Error('Embedder returned 0 vectors, expected 2')); // batch content fault
        if (texts[0] === 'text-0') return Promise.reject(new Error('hard content fault')); // single Error
        // Non-Error rejection to exercise the String(err) branch in errDetail.
        if (texts[0] === 'text-1') return Promise.reject('string-fault');
        return Promise.resolve(texts.map((t) => vec(t, 4)));
      },
    };
    const r = await embedBatch(pairs(2), e, 2, { delay: ZERO_DELAY });
    expect(r.embedded).toBe(0);
    expect(r.failed).toBe(2);
    const byId = new Map(r.failures.map((f) => [f.datasetId, f.reason]));
    expect(byId.get('d0')).toBe('single_text_failed:hard content fault');
    expect(byId.get('d1')).toBe('single_text_failed:string-fault');
  });

  it('a reorder that preserves the count is treated as in-order (count assertion drives salvage)', async () => {
    const e = new RecordingEmbedder({
      hook: (_texts, _callIndex, vectors) => [...vectors].reverse(), // same count, reordered
    });
    const got: Array<{ datasetId: string; vector: Float32Array }> = [];
    const r = await embedBatch(pairs(3), e, 3, { delay: ZERO_DELAY, onVector: (v) => got.push(v) });
    // count matches → no salvage path; mapping is positional-by-assumption (the embedder's bug)
    expect(r.embedderRequests).toBe(1);
    expect(r.embedded).toBe(3);
    expect(got.length).toBe(3);
  });
});

// --- T017: forced single-text mode ---------------------------------------------------------

describe('index.batch-embed forced single-text (T017, FR-005)', () => {
  it('effectiveBatchSize === 1 statically issues one text per request (no fault)', async () => {
    const e = new RecordingEmbedder({ maxBatchSize: 1 });
    const ps = [...pairs(3), { datasetId: 'empty', text: '' }];
    const r = await embedBatch(ps, e, 1, { delay: ZERO_DELAY });
    expect(e.calls.length).toBe(3); // N - skippedEmpty
    expect(e.calls.every((c) => c.length === 1)).toBe(true);
    expect(r.embedderRequests).toBe(3);
    expect(r.embedded).toBe(3);
    expect(r.skippedEmpty).toBe(1);
    expect(r.failed).toBe(0);
  });

  it('forced single still records a per-text failure when a text fails outright', async () => {
    const e = new RecordingEmbedder({
      maxBatchSize: 1,
      hook: (texts, _ci, vectors) => (texts[0] === 'text-1' ? [] : vectors),
    });
    const r = await embedBatch(pairs(3), e, 1, { delay: ZERO_DELAY });
    expect(r.embedded).toBe(2);
    expect(r.failed).toBe(1);
    expect(r.failures[0]?.reason).toMatch(/^single_text_failed:/);
  });
});

// --- T018: transient-batch-then-salvage budget interaction ---------------------------------

describe('index.batch-embed transient exhaustion (T018, FR-004/FR-009, SC-004)', () => {
  it('a batch that 429-exhausts falls to single-text retry; a text that also exhausts is recorded', async () => {
    const e = new RecordingEmbedder({
      hook: (texts) => {
        // d0 always 429s (batch and single); the rest succeed on single retry.
        if (texts.includes('text-0')) throw httpError(429);
        const vectors = texts.map((t) => vec(t, 4));
        return vectors;
      },
    });
    const r = await embedBatch(pairs(3), e, 3, { delay: ZERO_DELAY, maxRetries: 1 });
    expect(r.embedded).toBe(2); // d1, d2 salvaged as singles
    expect(r.failed).toBe(1); // d0 exhausts
    expect(r.failures[0]?.datasetId).toBe('d0');
    expect(r.failures[0]?.reason).toBe('transient_exhausted:429');
    expect(r.embedderRequests).toBeGreaterThan(3);
  });

  it('the run still processes remaining batches after a salvaged one', async () => {
    let firstBatchSeen = false;
    const e = new RecordingEmbedder({
      hook: (texts, _ci, vectors) => {
        if (!firstBatchSeen && texts.length > 1) {
          firstBatchSeen = true;
          return vectors.slice(0, texts.length - 1); // short the first batch only
        }
        return vectors;
      },
    });
    const r = await embedBatch(pairs(6), e, 3, { delay: ZERO_DELAY });
    expect(r.embedded).toBe(6); // first batch salvaged, second batch normal
    expect(r.failed).toBe(0);
  });
});

// --- T019: per-batch progress emission -----------------------------------------------------

describe('index.batch-embed progress (T019, FR-010)', () => {
  it('invokes onProgress once per batch with monotonic done/total and running counts', async () => {
    const e = new RecordingEmbedder();
    const seen: Array<{ batchesDone: number; batchesTotal: number; embedded: number }> = [];
    const r = await embedBatch(pairs(10), e, 4, {
      delay: ZERO_DELAY,
      onProgress: (p) =>
        seen.push({
          batchesDone: p.batchesDone,
          batchesTotal: p.batchesTotal,
          embedded: p.embedded,
        }),
    });
    expect(seen.length).toBe(3); // ceil(10/4)
    expect(seen.map((s) => s.batchesDone)).toEqual([1, 2, 3]);
    expect(seen.every((s) => s.batchesTotal === 3)).toBe(true);
    expect(seen[2]?.embedded).toBe(10);
    expect(r.embedderRequests).toBe(3);
  });

  it('batchesTotal accounts for the empty-text exclusion', async () => {
    const e = new RecordingEmbedder();
    const ps = [...pairs(4), { datasetId: 'e', text: '' }];
    let total = -1;
    await embedBatch(ps, e, 2, {
      delay: ZERO_DELAY,
      onProgress: (p) => {
        total = p.batchesTotal;
      },
    });
    expect(total).toBe(2); // ceil(4/2), the empty one excluded
  });
});
