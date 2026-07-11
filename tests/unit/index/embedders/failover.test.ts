import { describe, expect, it } from 'bun:test';
import type { Embedder } from '../../../../src/index/embedder.ts';
import { FailoverEmbedder } from '../../../../src/index/embedders/failover.ts';

const vec = (d: number) => new Float32Array(d);
const transient = () => Object.assign(new Error('endpoint down'), { httpStatus: 503 });
const content = () => new Error('bad input'); // no httpStatus → classifyEmbedError → content

/** A mock endpoint that records its calls and runs a scripted behavior. */
function ep(
  id: string,
  dimension: number,
  embed: (texts: string[]) => Promise<Float32Array[]>,
  maxBatchSize?: number,
): Embedder {
  return maxBatchSize != null ? { id, dimension, maxBatchSize, embed } : { id, dimension, embed };
}

describe('FailoverEmbedder (spec 069)', () => {
  it('serves from the first healthy endpoint and never touches the rest', async () => {
    const calls: string[] = [];
    const fo = new FailoverEmbedder([
      ep('a', 4, async () => {
        calls.push('a');
        return [vec(4)];
      }),
      ep('b', 4, async () => {
        calls.push('b');
        return [vec(4)];
      }),
    ]);
    const out = await fo.embed(['x']);
    expect(out[0]?.length).toBe(4);
    expect(calls).toEqual(['a']);
    expect(fo.id).toBe('a'); // stable identity = primary (FR-503)
    expect(fo.dimension).toBe(4);
  });

  it('falls over on a transient fault, trips the breaker, then prefers healthy — and retries after cooldown', async () => {
    const calls: string[] = [];
    let now = 1000;
    const fo = new FailoverEmbedder(
      [
        ep('a', 4, async () => {
          calls.push('a');
          throw transient();
        }),
        ep('b', 4, async () => {
          calls.push('b');
          return [vec(4)];
        }),
      ],
      { cooldownMs: 5000, now: () => now },
    );
    // call 1: a fails transiently → trip; b serves.
    expect((await fo.embed(['x']))[0]?.length).toBe(4);
    expect(calls).toEqual(['a', 'b']);
    // call 2 within cooldown: a is tripped → skipped; b tried first.
    calls.length = 0;
    await fo.embed(['y']);
    expect(calls).toEqual(['b']);
    // call 3 after cooldown: a is healthy again → tried first (still fails → falls to b).
    now += 6000;
    calls.length = 0;
    await fo.embed(['z']);
    expect(calls).toEqual(['a', 'b']);
  });

  it('rethrows a content fault without wasting the fallback', async () => {
    const calls: string[] = [];
    const fo = new FailoverEmbedder([
      ep('a', 4, async () => {
        calls.push('a');
        throw content();
      }),
      ep('b', 4, async () => {
        calls.push('b');
        return [vec(4)];
      }),
    ]);
    await expect(fo.embed(['x'])).rejects.toThrow('bad input');
    expect(calls).toEqual(['a']); // b never tried — content fails everywhere
  });

  it('a wrong-dimension result is a hard error (vector-space guard), not a silent fallthrough', async () => {
    const fo = new FailoverEmbedder([
      ep('a', 4, async () => [vec(8)]), // returns 8-dim vectors for a 4-dim chain
      ep('b', 4, async () => [vec(4)]),
    ]);
    await expect(fo.embed(['x'])).rejects.toThrow(/vector-space mismatch/);
  });

  it('throws AggregateError when every endpoint fails transiently — trying tripped ones as a last resort', async () => {
    const calls: string[] = [];
    let now = 1000;
    const fo = new FailoverEmbedder(
      [
        ep('a', 4, async () => {
          calls.push('a');
          throw transient();
        }),
        ep('b', 4, async () => {
          calls.push('b');
          throw transient();
        }),
      ],
      { now: () => now },
    );
    await expect(fo.embed(['x'])).rejects.toBeInstanceOf(AggregateError);
    // both now tripped; a second call still attempts both (nothing healthy → last resort).
    now += 1;
    calls.length = 0;
    await expect(fo.embed(['y'])).rejects.toBeInstanceOf(AggregateError);
    expect(calls.sort()).toEqual(['a', 'b']);
  });

  it('reports maxBatchSize as the most restrictive endpoint cap', () => {
    const fo = new FailoverEmbedder([
      ep('a', 4, async () => [vec(4)], 64),
      ep('b', 4, async () => [vec(4)], 16),
    ]);
    expect(fo.maxBatchSize).toBe(16);
    // no caps → undefined
    const fo2 = new FailoverEmbedder([ep('a', 4, async () => [vec(4)])]);
    expect(fo2.maxBatchSize).toBeUndefined();
  });

  it('rejects an empty chain and a dimension-mismatched chain at construction', () => {
    expect(() => new FailoverEmbedder([])).toThrow(/at least one/);
    expect(
      () =>
        new FailoverEmbedder([
          ep('a', 4, async () => [vec(4)]),
          ep('b', 8, async () => [vec(8)]), // different dimension
        ]),
    ).toThrow(/dimension mismatch/);
  });
});
