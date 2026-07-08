import { describe, expect, it } from 'bun:test';
import {
  applyGrid,
  compareCells,
  filterRows,
  isGridActive,
  sortRows,
} from '../../../src/read/resource-grid.ts';

const rows = [
  { station: 'Дружба', pm10: 42, note: 'ok' },
  { station: 'Надежда', pm10: 31, note: '' },
  { station: 'Павлово', pm10: 27, note: 'n/a' },
];

describe('compareCells', () => {
  it('compares numbers numerically', () => {
    expect(compareCells(9, 100)).toBeLessThan(0);
    expect(compareCells('42', '7')).toBeGreaterThan(0);
  });
  it('orders text by Bulgarian locale, blanks last', () => {
    expect(compareCells('Дружба', 'Надежда')).toBeLessThan(0);
    expect(compareCells('', 'x')).toBeGreaterThan(0);
  });
  it('treats non-number/non-string cells as non-numeric (boolean/object/null)', () => {
    // A boolean is neither number nor string → isNumeric hits its final `return false`, so the pair
    // falls through to text comparison rather than numeric subtraction.
    expect(compareCells(true, 5)).not.toBe(0);
    expect(compareCells(true, true)).toBe(0);
    // Objects stringify; null renders blank and sorts last.
    expect(compareCells({ a: 1 }, null)).toBeLessThan(0);
  });
});

describe('sortRows', () => {
  it('returns input untouched when no sort', () => {
    expect(sortRows(rows, null)).toBe(rows);
  });
  it('sorts numeric asc/desc and is stable', () => {
    expect(
      sortRows(rows, { col: 'pm10', dir: 'asc' }).map((r) => (r as { pm10: number }).pm10),
    ).toEqual([27, 31, 42]);
    expect(
      sortRows(rows, { col: 'pm10', dir: 'desc' }).map((r) => (r as { pm10: number }).pm10),
    ).toEqual([42, 31, 27]);
    const eq = [
      { a: 1, id: 'x' },
      { a: 1, id: 'y' },
    ];
    expect(sortRows(eq, { col: 'a', dir: 'asc' }).map((r) => (r as { id: string }).id)).toEqual([
      'x',
      'y',
    ]);
  });
});

describe('filterRows', () => {
  it('substring-matches case-insensitively, ANDs columns, ignores blanks', () => {
    expect(filterRows(rows, { station: 'дру' })).toHaveLength(1);
    expect(filterRows(rows, { station: 'д', note: '' })).toHaveLength(2); // Дружба, Надежда
    expect(filterRows(rows, { station: 'д', note: 'n' })).toHaveLength(0);
    expect(filterRows(rows, {})).toBe(rows);
  });
});

describe('applyGrid / isGridActive', () => {
  it('filters then sorts', () => {
    const out = applyGrid(rows, { sort: { col: 'pm10', dir: 'desc' }, filters: { station: 'д' } });
    expect(out.map((r) => (r as { station: string }).station)).toEqual(['Дружба', 'Надежда']);
  });
  it('detects whether any sort/filter is requested', () => {
    expect(isGridActive({ sort: null, filters: {} })).toBe(false);
    expect(isGridActive({ sort: null, filters: { a: '  ' } })).toBe(false);
    expect(isGridActive({ sort: { col: 'a', dir: 'asc' }, filters: {} })).toBe(true);
    expect(isGridActive({ sort: null, filters: { a: 'x' } })).toBe(true);
  });
});
