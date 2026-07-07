import { describe, expect, it } from 'bun:test';
import { LAST_SEEN_THROTTLE_MS, bumpDue } from './last-seen.ts';

describe('bumpDue (spec 043 FR-254)', () => {
  const t0 = '2026-07-07T00:00:00.000Z';
  const plus = (ms: number) => new Date(Date.parse(t0) + ms).toISOString();

  it('always bumps when there is no prior timestamp', () => {
    expect(bumpDue(null, t0)).toBe(true);
  });

  it('suppresses a bump inside the window and allows it once past', () => {
    expect(bumpDue(t0, plus(LAST_SEEN_THROTTLE_MS - 1000))).toBe(false);
    expect(bumpDue(t0, plus(LAST_SEEN_THROTTLE_MS))).toBe(true);
    expect(bumpDue(t0, plus(LAST_SEEN_THROTTLE_MS + 1000))).toBe(true);
  });

  it('honours a custom window', () => {
    expect(bumpDue(t0, plus(500), 1000)).toBe(false);
    expect(bumpDue(t0, plus(1000), 1000)).toBe(true);
  });
});
