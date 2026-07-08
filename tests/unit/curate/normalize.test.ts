import { describe, expect, it } from 'bun:test';
import {
  normalizeBoolean,
  normalizeDate,
  normalizeDecimal,
} from '../../../src/curate/normalize.ts';

describe('curate.normalize', () => {
  it('parses ISO-8601 date', () => {
    expect(normalizeDate('2026-05-08')?.iso).toBe('2026-05-08');
    expect(normalizeDate('2026-05-08T12:00:00Z')?.iso).toBe('2026-05-08');
  });

  it('parses dd.mm.yyyy', () => {
    expect(normalizeDate('8.5.2026')?.iso).toBe('2026-05-08');
    expect(normalizeDate('08/05/2026')?.iso).toBe('2026-05-08');
  });

  it('parses Bulgarian month names', () => {
    expect(normalizeDate('5 май 2026')?.iso).toBe('2026-05-05');
    expect(normalizeDate('15 декември 2024')?.iso).toBe('2024-12-15');
    expect(normalizeDate('1 неделя 2025')).toBeNull();
  });

  it('returns null on empty / unparseable', () => {
    expect(normalizeDate('')).toBeNull();
    expect(normalizeDate('not a date')).toBeNull();
  });

  it('parses BG decimals with comma', () => {
    expect(normalizeDecimal('1 234,56')?.value).toBeCloseTo(1234.56);
    expect(normalizeDecimal('1.234,56')?.value).toBeCloseTo(1234.56);
    expect(normalizeDecimal('1,5')?.rule).toBe('decimal-comma-to-point');
  });

  it('parses US-style decimals', () => {
    expect(normalizeDecimal('1234.56')?.value).toBeCloseTo(1234.56);
  });

  it('parses integers', () => {
    expect(normalizeDecimal('100')?.value).toBe(100);
    expect(normalizeDecimal('100')?.rule).toBe('integer');
  });

  it('returns null on non-numeric', () => {
    expect(normalizeDecimal('abc')).toBeNull();
    expect(normalizeDecimal('')).toBeNull();
  });

  it('returns null when a BG-locale number overflows to non-finite', () => {
    // matches the BG-locale regex but parseFloat overflows to Infinity
    expect(normalizeDecimal(`1${' 000'.repeat(120)}`)).toBeNull();
  });

  it('returns null when a US-locale number overflows to non-finite', () => {
    // matches the plain-integer regex but parseFloat overflows to Infinity
    expect(normalizeDecimal('9'.repeat(400))).toBeNull();
  });

  it('normalizes booleans (BG and EN)', () => {
    expect(normalizeBoolean('Да')).toBe(true);
    expect(normalizeBoolean('TRUE')).toBe(true);
    expect(normalizeBoolean('  1  ')).toBe(true);
    expect(normalizeBoolean('Не')).toBe(false);
    expect(normalizeBoolean('false')).toBe(false);
    expect(normalizeBoolean('maybe')).toBeNull();
  });
});
