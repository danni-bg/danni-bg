// Admin limit/reset actions as pure, non-throwing controllers (spec 057, FR-404). Previously the
// component fired `void saveLimit(row)` with no try/catch, so a failed save was an unhandled rejection
// and the table silently kept the stale value. These return a discriminated outcome the component
// surfaces to the admin — and never reject — so `bun:test` can assert the failure path hermetically.

export interface AdminUsageApi {
  setUserLimit: (userId: string, limit: number | null) => Promise<void>;
  resetUserUsage: (userId: string) => Promise<void>;
}

export type SaveResult =
  | { ok: true; limit: number | null }
  | { ok: false; reason: 'invalid' | 'error' };

/** Parse the raw edit and persist it. `invalid` = a non-numeric/negative entry (no request sent). */
export async function saveUserLimit(
  api: AdminUsageApi,
  userId: string,
  raw: string,
): Promise<SaveResult> {
  const trimmed = raw.trim();
  const limit = trimmed === '' ? null : Number.parseInt(trimmed, 10);
  if (limit !== null && (!Number.isFinite(limit) || limit < 0))
    return { ok: false, reason: 'invalid' };
  try {
    await api.setUserLimit(userId, limit);
    return { ok: true, limit };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

/** Reset a user's usage counter. Resolves `false` on failure rather than rejecting. */
export async function resetUsage(api: AdminUsageApi, userId: string): Promise<boolean> {
  try {
    await api.resetUserUsage(userId);
    return true;
  } catch {
    return false;
  }
}
