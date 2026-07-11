// Per-user chat-token quota math (token metering). Pure so it's unit-tested and shared by the chat
// gate (enforcement), the admin overview, and the per-user self view.

export interface QuotaView {
  used: number;
  limit: number; // effective limit; 0 = unlimited
  remaining: number | null; // null = unlimited
  exceeded: boolean;
}

/** Cache-hit input tokens count toward the quota at this weight (they're far cheaper). */
export const CACHE_WEIGHT = 0.1;

/**
 * Tokens that count toward the quota. Cache-hit input tokens are discounted to CACHE_WEIGHT of their
 * raw count (the rest of `total` counts in full): billable = total − (1 − weight)·cached.
 */
export function billableTokens(
  total: number,
  cached: number,
  weight: number = CACHE_WEIGHT,
): number {
  const capped = Math.min(Math.max(0, cached), Math.max(0, total));
  return Math.max(0, Math.round(total - (1 - weight) * capped));
}

/** A user's own `token_limit` overrides (including an explicit 0 = unlimited for them); else the
 * platform default; else 0 = unlimited. */
export function effectiveLimit(userLimit: number | null, defaultLimit?: number): number {
  if (userLimit != null) return Math.max(0, userLimit);
  return Math.max(0, defaultLimit ?? 0);
}

/**
 * A resolved chat allowance (spec 065). Unlike the legacy `limit` (where `0` means UNLIMITED), a
 * pool-model member's reserved slice of `0` means BLOCKED — so the two are represented explicitly:
 *   - `unlimited`  → legacy no-limit, or a BYOM org (pool bypassed).
 *   - `limited(N)` → a hard cap of N tokens; N = 0 blocks immediately (a member with no allocation).
 */
export type Allowance = { mode: 'unlimited' } | { mode: 'limited'; limit: number };

/** True when `used` has reached the allowance. `limited(0)` blocks at 0 (unlike `quotaView`). */
export function exceedsAllowance(a: Allowance, used: number): boolean {
  return a.mode === 'limited' && used >= a.limit;
}

/** The numeric cap to report in a 429 body (`0` for an unlimited allowance — never rejected). */
export function allowanceLimit(a: Allowance): number {
  return a.mode === 'limited' ? a.limit : 0;
}

/**
 * Resolve the effective chat allowance for a member (spec 065 FR-620/621/622):
 *   - legacy org (`pool === null`): today's semantics — `legacyLimit > 0` caps, else unlimited.
 *   - pool-model org on BYOM (`usesBYOM`): unlimited — the org pays its own provider (FR-621).
 *   - pool-model org on platform routing: the member's RESERVED slice; `null`/absent → `0` (blocked).
 */
export function chatAllowance(
  pool: number | null,
  usesBYOM: boolean,
  memberAllowance: number | null,
  legacyLimit: number,
): Allowance {
  if (pool === null)
    return legacyLimit > 0 ? { mode: 'limited', limit: legacyLimit } : { mode: 'unlimited' };
  if (usesBYOM) return { mode: 'unlimited' };
  return { mode: 'limited', limit: memberAllowance ?? 0 };
}

export function quotaView(used: number, limit: number): QuotaView {
  const unlimited = limit <= 0;
  return {
    used,
    limit: unlimited ? 0 : limit,
    remaining: unlimited ? null : Math.max(0, limit - used),
    exceeded: !unlimited && used >= limit,
  };
}

/**
 * FR-213 (spec 039): the token quota is enforced check-then-record — the gate reads `token_usage`
 * before the turn, the usage write lands after it — so N turns a user fires concurrently all read the
 * same total and all pass the same pre-check. We CONSCIOUSLY accept this rather than serialize a
 * user's turns behind a lock: this is a single-node, in-process server metering a *soft* token budget,
 * and a distributed/per-user lock would be over-engineering (YAGNI) for a limit that already tolerates
 * a small overshoot. The overrun is bounded, not open-ended: only the turns beyond the first can
 * overrun (the first is legitimately admitted at/under quota), and each in-flight turn bills at most
 * its `maxOutputTokens`-derived per-turn cost, so the worst case is (concurrentTurns − 1) × perTurnCost.
 * The transport layer already caps a session to one live generation, which keeps `concurrentTurns`
 * small in practice.
 */
export function maxConcurrentOverrun(concurrentTurns: number, perTurnCost: number): number {
  return Math.max(0, Math.trunc(concurrentTurns) - 1) * Math.max(0, perTurnCost);
}
