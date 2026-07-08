import { describe, expect, it } from 'bun:test';
import {
  ALL_ENTITY_PREDICATES,
  ENTITY_PREDICATES,
  isEntityPredicate,
} from '../../../../src/enrich/relations/vocabulary.ts';

describe('enrich.relations.vocabulary', () => {
  it('exposes the closed predicate set', () => {
    expect(ENTITY_PREDICATES.PART_OF).toBe('part_of');
    expect(ALL_ENTITY_PREDICATES).toContain('part_of');
    expect(ALL_ENTITY_PREDICATES.length).toBe(Object.keys(ENTITY_PREDICATES).length);
  });

  it('recognizes a valid predicate', () => {
    expect(isEntityPredicate('part_of')).toBe(true);
  });

  it('rejects an unknown predicate', () => {
    expect(isEntityPredicate('located_in')).toBe(false);
    expect(isEntityPredicate('')).toBe(false);
  });
});
