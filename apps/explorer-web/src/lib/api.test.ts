import { afterEach, describe, expect, it } from 'bun:test';
import { EMPTY_FILTERS, type FilterState } from '../types.ts';
import {
  buildUrl,
  fetchDataset,
  fetchDatasets,
  fetchFacets,
  fetchNational,
  fetchRegions,
  fetchResourceRows,
} from './api.ts';

const F = (over: Partial<FilterState> = {}): FilterState => ({ ...EMPTY_FILTERS, ...over });
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(captured: { url?: string }, body: unknown, ok = true): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    captured.url = typeof input === 'string' ? input : input.toString();
    // The shared `request` helper reads the body via `text()` (parse-if-non-empty).
    return {
      ok,
      status: ok ? 200 : 500,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }) as typeof fetch;
}

describe('buildUrl', () => {
  it('omits the query string when empty', () => {
    expect(buildUrl('/api/datasets')).toBe('/api/datasets');
    expect(buildUrl('/api/datasets', new URLSearchParams())).toBe('/api/datasets');
    expect(buildUrl('/api/datasets', new URLSearchParams({ a: '1' }))).toBe('/api/datasets?a=1');
  });
});

describe('fetch wrappers', () => {
  it('fetchRegions adds the level param', async () => {
    const cap: { url?: string } = {};
    stubFetch(cap, { regions: [] });
    await fetchRegions(F({ tags: ['t'] }), 'municipality');
    expect(cap.url).toContain('/api/regions?');
    expect(cap.url).toContain('level=municipality');
    expect(cap.url).toContain('tags=t');
  });

  it('fetchDatasets adds pagination', async () => {
    const cap: { url?: string } = {};
    stubFetch(cap, { datasets: [], total: 0, limit: 10, offset: 5 });
    const out = await fetchDatasets(F(), 10, 5);
    expect(cap.url).toContain('limit=10');
    expect(cap.url).toContain('offset=5');
    expect(out.total).toBe(0);
  });

  it('fetchNational hits the national endpoint with pagination', async () => {
    const cap: { url?: string } = {};
    stubFetch(cap, { datasets: [], total: 0, limit: 50, offset: 0 });
    await fetchNational(F());
    expect(cap.url).toContain('/api/national?');
    expect(cap.url).toContain('limit=50');
  });

  it('fetchFacets hits the facets endpoint', async () => {
    const cap: { url?: string } = {};
    stubFetch(cap, { tags: [], publishers: [], freshnessBuckets: [] });
    await fetchFacets(F({ tags: ['t'] }));
    expect(cap.url).toContain('/api/facets?');
    expect(cap.url).toContain('tags=t');
  });

  it('fetchDataset encodes the id into the path', async () => {
    const cap: { url?: string } = {};
    stubFetch(cap, { datasetId: 'a/b', title: {} });
    const out = await fetchDataset('a/b');
    expect(cap.url).toBe('/api/datasets/a%2Fb');
    expect(out.datasetId).toBe('a/b');
  });

  it('throws on a non-ok response', async () => {
    stubFetch({}, {}, false);
    await expect(fetchDatasets(F())).rejects.toThrow('request failed');
  });
});

describe('fetchResourceRows', () => {
  it('sends bare pagination when no grid query is given', async () => {
    const cap: { url?: string } = {};
    stubFetch(cap, { kind: 'grid', rows: [] });
    await fetchResourceRows('d1', 'r1');
    expect(cap.url).toContain('/api/datasets/d1/resources/r1/rows?');
    expect(cap.url).toContain('limit=50');
    expect(cap.url).toContain('offset=0');
    expect(cap.url).not.toContain('sort=');
    expect(cap.url).not.toContain('filters=');
  });

  it('encodes ids and forwards sort + only the non-blank filters', async () => {
    const cap: { url?: string } = {};
    stubFetch(cap, { kind: 'grid', rows: [] });
    await fetchResourceRows('d/1', 'r 1', 20, 40, {
      sort: { col: 'year', dir: 'desc' },
      filters: { region: ' Русе ', empty: '   ' }, // the all-whitespace filter is dropped
    });
    expect(cap.url).toContain('/api/datasets/d%2F1/resources/r%201/rows?');
    expect(cap.url).toContain('limit=20');
    expect(cap.url).toContain('offset=40');
    expect(cap.url).toContain('sort=year');
    expect(cap.url).toContain('dir=desc');
    const filters = new URL(`http://x${cap.url}`).searchParams.get('filters');
    expect(JSON.parse(filters ?? '{}')).toEqual({ region: ' Русе ' });
  });

  it('omits the filters param entirely when every value is blank', async () => {
    const cap: { url?: string } = {};
    stubFetch(cap, { kind: 'grid', rows: [] });
    await fetchResourceRows('d1', 'r1', 50, 0, { sort: null, filters: { a: '', b: '  ' } });
    expect(cap.url).not.toContain('filters=');
    expect(cap.url).not.toContain('sort=');
  });
});
