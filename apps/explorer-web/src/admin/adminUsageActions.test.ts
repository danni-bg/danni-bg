import { describe, expect, it, mock } from 'bun:test';
import { type AdminUsageApi, resetUsage, saveUserLimit } from './adminUsageActions.ts';

function api(over: Partial<AdminUsageApi> = {}): AdminUsageApi {
  return {
    setUserLimit: mock(async () => {}),
    resetUserUsage: mock(async () => {}),
    ...over,
  };
}

describe('saveUserLimit', () => {
  it('persists a valid limit and reports it', async () => {
    const setUserLimit = mock(async () => {});
    const res = await saveUserLimit(api({ setUserLimit }), 'u1', ' 500 ');
    expect(res).toEqual({ ok: true, limit: 500 });
    expect(setUserLimit).toHaveBeenCalledWith('u1', 500);
  });

  it('treats an empty entry as "clear override" (null)', async () => {
    const setUserLimit = mock(async () => {});
    const res = await saveUserLimit(api({ setUserLimit }), 'u1', '   ');
    expect(res).toEqual({ ok: true, limit: null });
    expect(setUserLimit).toHaveBeenCalledWith('u1', null);
  });

  it('rejects an invalid entry without sending a request', async () => {
    const setUserLimit = mock(async () => {});
    expect(await saveUserLimit(api({ setUserLimit }), 'u1', '-5')).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(await saveUserLimit(api({ setUserLimit }), 'u1', 'abc')).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(setUserLimit).not.toHaveBeenCalled();
  });

  // SC-3: a failed save surfaces an error instead of an unhandled rejection + silent stale value.
  it('surfaces a failing setUserLimit as an error outcome without throwing', async () => {
    const setUserLimit = mock(async () => {
      throw new Error('500');
    });
    const res = await saveUserLimit(api({ setUserLimit }), 'u1', '10');
    expect(res).toEqual({ ok: false, reason: 'error' });
  });
});

describe('resetUsage', () => {
  it('returns true on success', async () => {
    expect(await resetUsage(api(), 'u1')).toBe(true);
  });

  it('returns false (never throws) when the reset fails', async () => {
    const resetUserUsage = mock(async () => {
      throw new Error('boom');
    });
    expect(await resetUsage(api({ resetUserUsage }), 'u1')).toBe(false);
  });
});
