import { describe, expect, it } from 'bun:test';
import {
  UnsupportedScopeFieldError,
  assertScopeSupported,
  buildScopePredicate,
  egovPublisherId,
  egovSummaryInScope,
  summarizeScope,
} from '../../../src/crawler/scope.ts';

describe('crawler.scope', () => {
  it('empty filter matches everything', () => {
    const pred = buildScopePredicate({});
    expect(pred({ id: 'd1' })).toBe(true);
    expect(summarizeScope({})).toBe('all');
  });

  it('matches by publisher', () => {
    const pred = buildScopePredicate({ publishers: ['org-a'] });
    expect(pred({ id: 'd1', publisherId: 'org-a' })).toBe(true);
    expect(pred({ id: 'd2', publisherId: 'org-b' })).toBe(false);
  });

  it('matches by category', () => {
    const pred = buildScopePredicate({ categories: ['cat-1'] });
    expect(pred({ id: 'd1', groups: ['cat-1', 'cat-2'] })).toBe(true);
    expect(pred({ id: 'd2', groups: ['cat-x'] })).toBe(false);
  });

  it('matches by tag', () => {
    const pred = buildScopePredicate({ tags: ['t1'] });
    expect(pred({ id: 'd1', tags: ['t1'] })).toBe(true);
    expect(pred({ id: 'd2', tags: ['other'] })).toBe(false);
  });

  it('matches by explicit dataset id or slug', () => {
    const pred = buildScopePredicate({ datasetIds: ['d1', 'slug-2'] });
    expect(pred({ id: 'd1' })).toBe(true);
    expect(pred({ id: 'd2', slug: 'slug-2' })).toBe(true);
    expect(pred({ id: 'd3' })).toBe(false);
  });

  it('summarizeScope reports filter sizes', () => {
    const out = summarizeScope({
      publishers: ['a'],
      categories: ['b'],
      tags: ['c'],
      datasetIds: ['d'],
    });
    expect(out).toContain('publishers=1');
    expect(out).toContain('categories=1');
    expect(out).toContain('tags=1');
    expect(out).toContain('datasetIds=1');
  });
});

describe('crawler.scope adapter capability (spec 048, FR-302)', () => {
  it('ckan expresses every scope field (never throws)', () => {
    expect(() =>
      assertScopeSupported(
        { publishers: ['p'], categories: ['c'], tags: ['t'], datasetIds: ['d'] },
        'ckan',
      ),
    ).not.toThrow();
  });

  it('egov-bg rejects a categories scope, naming the field and the adapter', () => {
    expect(() => assertScopeSupported({ categories: ['транспорт'] }, 'egov-bg')).toThrow(
      UnsupportedScopeFieldError,
    );
    try {
      assertScopeSupported({ categories: ['x'] }, 'egov-bg');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedScopeFieldError);
      const e = err as UnsupportedScopeFieldError;
      expect(e.message).toContain('categories');
      expect(e.message).toContain('egov-bg');
      expect(e.details).toEqual({ field: 'categories', api: 'egov-bg' });
    }
  });

  it('egov-bg accepts publisher/tag/datasetId scopes (empty categories is fine)', () => {
    expect(() =>
      assertScopeSupported(
        { publishers: ['egov-org-1'], tags: ['t'], datasetIds: ['d'], categories: [] },
        'egov-bg',
      ),
    ).not.toThrow();
    expect(() => assertScopeSupported({}, 'egov-bg')).not.toThrow();
  });
});

describe('crawler.scope egov enumeration filter (spec 048, FR-300/303)', () => {
  it('egovPublisherId maps a numeric org_id to egov-org-<id> (absent → undefined)', () => {
    expect(egovPublisherId(113)).toBe('egov-org-113');
    expect(egovPublisherId(null)).toBeUndefined();
    expect(egovPublisherId(undefined)).toBeUndefined();
  });

  it('an unscoped filter keeps every summary', () => {
    expect(egovSummaryInScope({ org_id: 1 }, {})).toBe(true);
    expect(egovSummaryInScope({ org_id: null }, {})).toBe(true);
  });

  it('a publisher scope keeps only summaries of that publisher (SC-1)', () => {
    const scope = { publishers: ['egov-org-113'] };
    expect(egovSummaryInScope({ org_id: 113 }, scope)).toBe(true);
    expect(egovSummaryInScope({ org_id: 7 }, scope)).toBe(false);
    expect(egovSummaryInScope({ org_id: null }, scope)).toBe(false);
  });

  it('a tag scope keeps every summary as a candidate (tags resolved at processing time, FR-301)', () => {
    const scope = { tags: ['ппс'] };
    expect(egovSummaryInScope({ org_id: 113 }, scope)).toBe(true);
    expect(egovSummaryInScope({ org_id: 7 }, scope)).toBe(true);
  });

  it('a union publisher+tag scope keeps candidates so a tag-only match is not lost', () => {
    // org 7 is not the scoped publisher, but might carry the tag → kept for the details check.
    const scope = { publishers: ['egov-org-113'], tags: ['ппс'] };
    expect(egovSummaryInScope({ org_id: 7 }, scope)).toBe(true);
  });
});

describe('crawler.scope adapter parity (spec 048, FR-305/SC-4)', () => {
  // The egov processing-time in-scope check IS buildScopePredicate over the full details, so a
  // dataset in-scope on egov is in-scope on CKAN for the fields both adapters support.
  const cases = [
    { scope: { publishers: ['egov-org-113'] }, org_id: 113, tags: ['t'] as string[], want: true },
    { scope: { publishers: ['egov-org-113'] }, org_id: 7, tags: ['t'], want: false },
    { scope: { tags: ['ппс'] }, org_id: 7, tags: ['ппс', 'x'], want: true },
    { scope: { tags: ['ппс'] }, org_id: 7, tags: ['x'], want: false },
    { scope: {}, org_id: 7, tags: [] as string[], want: true },
  ];
  for (const c of cases) {
    it(`egov details vs buildScopePredicate agree for ${JSON.stringify(c.scope)} / org ${c.org_id}`, () => {
      const summary = {
        id: 'uri-1',
        slug: 'ds-1',
        publisherId: egovPublisherId(c.org_id),
        tags: c.tags,
      };
      expect(buildScopePredicate(c.scope)(summary)).toBe(c.want);
    });
  }
});
