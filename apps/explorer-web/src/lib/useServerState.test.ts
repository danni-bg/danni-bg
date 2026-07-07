import { describe, expect, it } from 'bun:test';
import { type QueryState, runQuery, viewStatus } from './useServerState.ts';

const flush = () => new Promise((r) => setTimeout(r, 0));

/** A promise whose settlement we control, so we can assert emits before/after resolution. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let n = 0;
const uniqueKey = () => `k-${n++}`;

describe('runQuery — lifecycle', () => {
  it('emits loading then data on success', async () => {
    const emits: QueryState<number>[] = [];
    runQuery(
      uniqueKey(),
      async () => 42,
      (s) => emits.push(s),
    );
    expect(emits[0]).toEqual({ data: undefined, error: null, loading: true });
    await flush();
    expect(emits.at(-1)).toEqual({ data: 42, error: null, loading: false });
  });

  it('emits loading then error on rejection (never a fake empty success)', async () => {
    const emits: QueryState<number>[] = [];
    runQuery(
      uniqueKey(),
      async () => {
        throw new Error('boom');
      },
      (s) => emits.push(s),
    );
    await flush();
    const last = emits.at(-1);
    expect(last?.loading).toBe(false);
    expect(last?.data).toBeUndefined();
    expect(last?.error).toBeInstanceOf(Error);
    expect(last?.error?.message).toBe('boom');
  });
});

describe('runQuery — cancellation', () => {
  it('does not emit after cancel (no setState-after-unmount)', async () => {
    const emits: QueryState<number>[] = [];
    const d = deferred<number>();
    const cancel = runQuery(
      uniqueKey(),
      () => d.promise,
      (s) => emits.push(s),
    );
    expect(emits).toHaveLength(1); // only the loading emit
    cancel();
    d.resolve(7);
    await flush();
    expect(emits).toHaveLength(1); // the resolved value was dropped
    expect(emits[0]?.loading).toBe(true);
  });
});

describe('runQuery — dedup + key-change refetch', () => {
  it('shares one in-flight request for identical keys, then both receive the data', async () => {
    const key = uniqueKey();
    let calls = 0;
    const d = deferred<{ x: number }>();
    const loader = () => {
      calls++;
      return d.promise;
    };
    const a: QueryState<{ x: number }>[] = [];
    const b: QueryState<{ x: number }>[] = [];
    runQuery(key, loader, (s) => a.push(s));
    runQuery(key, loader, (s) => b.push(s));
    expect(calls).toBe(1); // deduped
    d.resolve({ x: 1 });
    await flush();
    expect(a.at(-1)?.data).toEqual({ x: 1 });
    expect(b.at(-1)?.data).toEqual({ x: 1 });
  });

  it('invokes the loader once per distinct key (a key change refetches)', async () => {
    let calls = 0;
    const loader = async () => ++calls;
    runQuery(uniqueKey(), loader, () => {});
    runQuery(uniqueKey(), loader, () => {});
    await flush();
    expect(calls).toBe(2);
  });

  it('clears the in-flight entry after settling so a later same-key run refetches', async () => {
    const key = uniqueKey();
    let calls = 0;
    const loader = async () => ++calls;
    runQuery(key, loader, () => {});
    await flush();
    runQuery(key, loader, () => {});
    await flush();
    expect(calls).toBe(2);
  });
});

describe('viewStatus — distinguishes loaded-empty from failed', () => {
  it('is error whenever an error is present (even with no data)', () => {
    expect(viewStatus({ loading: false, error: new Error('x'), data: undefined })).toBe('error');
  });

  it('is loading only before the first result', () => {
    expect(viewStatus({ loading: true, error: null, data: undefined })).toBe('loading');
  });

  it('is ready for a successfully-loaded EMPTY result (not confused with error)', () => {
    expect(viewStatus({ loading: false, error: null, data: [] })).toBe('ready');
  });
});
