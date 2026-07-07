import { describe, expect, it } from 'bun:test';
import type { FreshnessBlock } from '../types.ts';
import { formatDate, formatNumber, freshnessDisplay, initials } from './format.ts';

describe('formatNumber', () => {
  it('group-separates in the bg-BG locale', () => {
    expect(formatNumber(42)).toBe('42');
    // bg-BG groups thousands with a (no-break) space; assert digits + separators, separator-agnostic.
    expect(formatNumber(1234567)).toMatch(/^1\s234\s567$/);
  });
});

describe('formatDate', () => {
  it('renders a medium bg-BG date and an em dash for null', () => {
    expect(formatDate(null)).toBe('—');
    const out = formatDate('2026-06-01T12:00:00Z');
    expect(out).not.toBe('—');
    expect(out).toContain('2026');
  });
});

describe('initials', () => {
  it('takes first+last token from a display name (former UserMenu signature)', () => {
    expect(initials('Иван Петров')).toBe('ИП');
  });
  it('takes first+last token from an email (former AvatarUpload signature)', () => {
    expect(initials('valentin.yanakiev@gmail.com')).toBe('VC');
  });
  it('single token → one initial; empty → a placeholder', () => {
    expect(initials('single')).toBe('S');
    expect(initials('')).toBe('?');
  });
});

describe('freshnessDisplay', () => {
  const base: FreshnessBlock = {
    lastSyncedAt: '2026-06-01T12:00:00Z',
    sourceLastModified: null,
    sourceEtagOrHash: null,
    isStale: false,
    freshnessSloSeconds: 86400,
  };
  it('renders fresh and stale variants with the date', () => {
    expect(freshnessDisplay(base)).toEqual({ label: 'актуално · 2026-06-01', isStale: false });
    expect(freshnessDisplay({ ...base, isStale: true })).toEqual({
      label: 'остаряло · последно 2026-06-01',
      isStale: true,
    });
  });
});
