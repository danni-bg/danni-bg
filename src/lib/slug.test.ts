import { describe, expect, it } from 'bun:test';
import { slugify } from './slug.ts';

describe('slugify (spec 064)', () => {
  it('lowercases, collapses whitespace, and keeps Cyrillic letters', () => {
    expect(slugify('Моята Фирма')).toBe('моята-фирма');
    expect(slugify('Acme Corp')).toBe('acme-corp');
    expect(slugify('  Много   интервали  ')).toBe('много-интервали');
  });

  it('drops punctuation/symbols and collapses/trims dashes', () => {
    expect(slugify('Foo & Bar, Inc.')).toBe('foo-bar-inc');
    expect(slugify('--hello--')).toBe('hello');
    expect(slugify('a---b')).toBe('a-b');
  });

  it('returns empty when nothing slug-worthy remains', () => {
    expect(slugify('!!! ???')).toBe('');
    expect(slugify('🎉🎉')).toBe('');
  });

  it('caps length and never ends on a dash', () => {
    const out = slugify('дума '.repeat(40)); // long, dash-separated
    expect(out.length).toBeLessThanOrEqual(64);
    expect(out.endsWith('-')).toBe(false);
  });
});
