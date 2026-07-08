// React-binding coverage for `useServerState` (the framework-agnostic `runQuery` core is tested
// without a DOM in useServerState.test.ts). These exercise the hook: initial load, error, refetch
// (bypassing the in-flight cache), stale-while-revalidate on a key change, and unmount cancellation.

import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test';
import { setupDom, teardownDom } from '../test-dom.ts';

beforeAll(setupDom);
afterAll(teardownDom);

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useServerState } from './useServerState.ts';

afterEach(cleanup);
let seq = 0;
const key = () => `hook-${seq++}`;

describe('useServerState — React hook', () => {
  it('emits loading then data + a ready status', async () => {
    const loader = mock(async () => ({ n: 1 }));
    const { result } = renderHook((k: string) => useServerState(k, loader), {
      initialProps: key(),
    });
    expect(result.current.loading).toBe(true);
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.data).toEqual({ n: 1 });
    expect(result.current.error).toBeNull();
  });

  it('surfaces a loader rejection as an error status', async () => {
    const loader = mock(async () => {
      throw new Error('nope');
    });
    const k = key();
    const { result } = renderHook(() => useServerState(k, loader));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error?.message).toBe('nope');
  });

  it('refetch re-invokes the loader, bypassing the in-flight dedup cache', async () => {
    let n = 0;
    const loader = () => Promise.resolve(++n);
    const { result } = renderHook(() => useServerState('hook-refetch', loader));
    await waitFor(() => expect(result.current.data).toBe(1));
    act(() => result.current.refetch());
    await waitFor(() => expect(result.current.data).toBe(2));
  });

  it('keeps the previous data visible while a new key loads (stale-while-revalidate)', async () => {
    let release!: (v: number) => void;
    const loaders: Record<string, () => Promise<number>> = {
      a: async () => 1,
      b: () =>
        new Promise<number>((r) => {
          release = r;
        }),
    };
    const { result, rerender } = renderHook((k: 'a' | 'b') => useServerState(k, loaders[k]), {
      initialProps: 'a' as 'a' | 'b',
    });
    await waitFor(() => expect(result.current.data).toBe(1));

    rerender('b'); // key change: still loading, but the old data stays put (no empty flash)
    expect(result.current.data).toBe(1);
    expect(result.current.loading).toBe(true);
    await act(async () => {
      release(2);
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.data).toBe(2));
  });

  it('cancels on unmount without a post-unmount state update', async () => {
    let release!: (v: number) => void;
    const loader = () =>
      new Promise<number>((r) => {
        release = r;
      });
    const k = key();
    const { result, unmount } = renderHook(() => useServerState(k, loader));
    expect(result.current.loading).toBe(true);
    unmount();
    await act(async () => {
      release(9); // resolves after unmount — the cancel() must swallow it (no throw)
      await Promise.resolve();
    });
  });
});
