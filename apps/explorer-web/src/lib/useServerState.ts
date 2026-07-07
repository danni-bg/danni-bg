// One `useQuery`-style hook owning the GET lifecycle (spec 057, FR-401/FR-402): loading flag, error
// state, data, cancellation on unmount/key-change, and in-flight dedup of identical keys. This
// replaces ~10 hand-rolled `fetch + useEffect + cancelled-flag` blocks and their error-swallowing.
//
// DECISION (FR-401): a small in-house hook, NOT TanStack Query. The app has ~10 GET call sites, no
// mutation/invalidation graph, and a constitution that prizes dependency-minimal, pure-tested `lib/*`
// — a query library is not yet earned. Revisit if cross-view caching or optimistic updates arrive.
//
// The fetch lifecycle is a framework-agnostic core (`runQuery`) so it is unit-tested without a DOM
// (matching the useChatSession precedent); the React hook is a thin wrapper over it.

import { useCallback, useEffect, useRef, useState } from 'react';

export interface QueryState<T> {
  data: T | undefined;
  error: Error | null;
  loading: boolean;
}

/** Coarse render status shared by every view so "loaded empty" is never confused with "failed". */
export type ViewStatus = 'loading' | 'error' | 'ready';
export function viewStatus(q: {
  loading: boolean;
  error: Error | null;
  data: unknown;
}): ViewStatus {
  if (q.error) return 'error';
  if (q.loading && q.data === undefined) return 'loading';
  return 'ready';
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

// In-flight requests keyed by their query key: identical concurrent keys share one promise (dedup),
// so a StrictMode double-invoke or two components asking the same thing hit the network once.
const inflight = new Map<string, Promise<unknown>>();

/**
 * Run one query: emit `loading`, then `data` or `error`. Returns a `cancel()` that stops any further
 * emit (so no state update lands after unmount/key-change). Cancellation is cooperative — the shared
 * in-flight promise is left to settle for other subscribers rather than aborted out from under them.
 */
export function runQuery<T>(
  key: string,
  loader: () => Promise<T>,
  emit: (s: QueryState<T>) => void,
): () => void {
  let cancelled = false;
  emit({ data: undefined, error: null, loading: true });

  let promise = inflight.get(key) as Promise<T> | undefined;
  if (!promise) {
    promise = loader();
    inflight.set(key, promise);
    // Evict once settled. Attached as (onFulfilled, onRejected) so this chain also HANDLES a
    // rejection — a `.finally(...)` here would re-reject and surface as an unhandled rejection.
    const evict = () => {
      if (inflight.get(key) === promise) inflight.delete(key);
    };
    promise.then(evict, evict);
  }
  promise.then(
    (data) => {
      if (!cancelled) emit({ data, error: null, loading: false });
    },
    (err) => {
      if (!cancelled) emit({ data: undefined, error: toError(err), loading: false });
    },
  );

  return () => {
    cancelled = true;
  };
}

export interface QueryResult<T> extends QueryState<T> {
  status: ViewStatus;
  /** Re-run the loader (bypassing the in-flight cache) — wire this to an error-affordance retry. */
  refetch: () => void;
}

/**
 * Subscribe a component to a keyed GET. `key` identifies the request (serialize the params into it);
 * when it changes the previous run is cancelled and a fresh one starts. `loader` is read from a ref
 * so an inline closure does not re-trigger — only `key` (and an explicit `refetch`) drive a refetch.
 */
export function useServerState<T>(key: string, loader: () => Promise<T>): QueryResult<T> {
  const [state, setState] = useState<QueryState<T>>({
    data: undefined,
    error: null,
    loading: true,
  });
  const [nonce, setNonce] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    // A forced refetch must not reuse a stale in-flight promise for this key. `loader` is read from
    // the ref (kept out of the deps on purpose) so only `key`/`nonce` drive a refetch.
    if (nonce > 0) inflight.delete(key);
    // Keep the previous data visible WHILE a new key loads (stale-while-revalidate) so a filter
    // change never flashes the empty state; the terminal emit (data OR error) replaces it.
    return runQuery(
      key,
      () => loaderRef.current(),
      (s) => setState((prev) => (s.loading ? { ...s, data: prev.data } : s)),
    );
  }, [key, nonce]);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, status: viewStatus(state), refetch };
}
