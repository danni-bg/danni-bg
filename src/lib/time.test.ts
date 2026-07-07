import { describe, expect, it } from 'bun:test';
import { isStale } from './time.ts';

describe('lib/time isStale (spec 055 FR-373)', () => {
  // A fixed clock so the boundary cases don't depend on wall time.
  const now = Date.parse('2026-07-07T12:00:00.000Z');
  const slo = 86_400; // 1 day
  const at = (secondsAgo: number) => new Date(now - secondsAgo * 1000).toISOString();

  it('is NOT stale exactly at the SLO boundary (strict >)', () => {
    expect(isStale(at(slo), slo, now)).toBe(false);
  });

  it('is stale just over the SLO', () => {
    expect(isStale(at(slo + 1), slo, now)).toBe(true);
  });

  it('is not stale under the SLO', () => {
    expect(isStale(at(slo - 1), slo, now)).toBe(false);
    expect(isStale(at(0), slo, now)).toBe(false);
  });

  it('treats a null/undefined timestamp as stale (never-synced)', () => {
    expect(isStale(null, slo, now)).toBe(true);
    expect(isStale(undefined, slo, now)).toBe(true);
  });

  it('defaults `now` to the current clock when omitted', () => {
    // A timestamp far in the past is stale; one far in the future is not — independent of the exact clock.
    expect(isStale('1970-01-01T00:00:00.000Z', slo)).toBe(true);
    expect(isStale('2999-01-01T00:00:00.000Z', slo)).toBe(false);
  });
});
