import { diffSeconds } from '../../lib/time.ts';

// Throttled "last seen" bookkeeping (spec 043 FR-254). The serving layer bumps per-row activity
// timestamps (`users.last_login_at`, `api_keys.last_used_at`) on *every* authenticated request, so
// each read was also a SQLite write — needless WAL churn and worst-case fuel for writer contention.
// We instead bump at most once per window per row, trading "exact last use" for "last use within N
// minutes". Readers of these fields already tolerate coarse granularity.

/** How stale a "last seen" timestamp must be before it is bumped again. */
export const LAST_SEEN_THROTTLE_MS = 5 * 60_000; // 5 minutes

/** True when `previous` is unset or older than `windowMs` before `now` — i.e. a bump is due. */
export function bumpDue(
  previous: string | null,
  now: string,
  windowMs: number = LAST_SEEN_THROTTLE_MS,
): boolean {
  if (!previous) return true;
  return diffSeconds(now, previous) * 1000 >= windowMs;
}
