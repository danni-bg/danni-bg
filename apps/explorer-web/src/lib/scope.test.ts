import { describe, expect, it } from 'bun:test';
import { EMPTY_FILTERS, type FilterState } from '../types.ts';
import { filterStateToParams, filterStateToScope } from './scope.ts';

const F = (over: Partial<FilterState> = {}): FilterState => ({ ...EMPTY_FILTERS, ...over });

describe('filterStateToParams', () => {
  it('encodes empty filters to no params', () => {
    expect(filterStateToParams(F()).toString()).toBe('');
  });

  it('encodes all active filters with repeats + trimmed query', () => {
    const p = filterStateToParams(
      F({
        tags: ['a', 'b'],
        publisherIds: ['p1'],
        geoUnitIds: ['g1'],
        freshness: 'stale',
        query: '  въздух ',
        includeWithdrawn: true,
      }),
    );
    expect(p.getAll('tags')).toEqual(['a', 'b']);
    expect(p.get('publisherIds')).toBe('p1');
    expect(p.get('geoUnitIds')).toBe('g1');
    expect(p.get('freshness')).toBe('stale');
    expect(p.get('q')).toBe('въздух');
    expect(p.get('includeWithdrawn')).toBe('true');
  });
});

describe('filterStateToScope', () => {
  it('empty filters → empty scope', () => {
    expect(filterStateToScope(F())).toEqual({});
  });

  it('carries active fields incl. soft query', () => {
    expect(
      filterStateToScope(
        F({ tags: ['t'], freshness: 'fresh', query: 'q', includeWithdrawn: true }),
      ),
    ).toEqual({
      tags: ['t'],
      freshness: 'fresh',
      query: 'q',
      includeWithdrawn: true,
    });
  });
});
