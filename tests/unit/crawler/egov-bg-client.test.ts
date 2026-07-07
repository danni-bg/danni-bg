import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackoffRunner } from '../../../src/crawler/backoff.ts';
import { EgovBgClient } from '../../../src/crawler/egov-bg-client.ts';
import { PortalHttp } from '../../../src/crawler/http.ts';
import { RateLimiter } from '../../../src/crawler/rate-limit.ts';
import { RobotsCache } from '../../../src/crawler/robots.ts';
import { CkanApiError } from '../../../src/lib/errors.ts';

const FIX = fileURLToPath(new URL('../../fixtures/egov/', import.meta.url));
const fixture = (name: string): string => readFileSync(join(FIX, `${name}.json`), 'utf-8');

interface Captured {
  url: string;
  body: unknown;
}

function makeClient(
  responder: (
    method: string,
    body: unknown,
  ) => { status?: number; json: unknown; rawText?: boolean },
  captured: Captured[] = [],
  apiKey?: string,
): EgovBgClient {
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    const u = url.toString();
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    captured.push({ url: u, body });
    const method = u.split('/').pop() ?? '';
    const { status = 200, json, rawText = false } = responder(method, body);
    // `rawText` sends `json` (a string) as the exact response body — used to assert byte-faithful
    // capture where JSON.stringify would normalize away the portal's original formatting.
    const respBody = rawText ? (json as string) : JSON.stringify(json);
    return new Response(respBody, { status }) as unknown as Response;
  }) as unknown as typeof fetch;

  const http = new PortalHttp({
    userAgent: 'danni-bg/test',
    rateLimiter: new RateLimiter({ requestsPerSecond: 100, concurrency: 4 }),
    backoff: new BackoffRunner({
      initialMs: 10,
      maxMs: 100,
      failureBudget: 1,
      sleep: async () => {},
    }),
    robots: new RobotsCache({ recheckIntervalSeconds: 86400, obey: false }),
    fetcher,
  });
  return new EgovBgClient({ baseUrl: 'https://data.egov.bg/api/', http, apiKey });
}

const fixtureResponder = (method: string) => ({ json: JSON.parse(fixture(method)) });

describe('crawler.egov-bg-client', () => {
  it('lists datasets', async () => {
    const res = await makeClient(fixtureResponder).listDatasets({ recordsPerPage: 3 });
    expect(res.success).toBe(true);
    expect(res.datasets.length).toBe(3);
    expect(res.datasets[0]?.uri).toBe('2e634036-6ab9-4efd-bd8e-c8e14a931911');
  });

  it('gets dataset details with tags and resources', async () => {
    const det = await makeClient(fixtureResponder).getDatasetDetails('2e634036');
    expect(det.data.name.length).toBeGreaterThan(0);
    expect((det.data.tags ?? []).map((t) => t.name)).toContain('ППС');
    const res = await makeClient(fixtureResponder).listResources('2e634036');
    expect(res.resources[0]?.file_format).toBe('CSV');
  });

  it('returns the datastore response body VERBATIM (byte-faithful capture, spec 049 FR-310)', async () => {
    // The portal's exact bytes come back untouched — no parse/re-serialize — so `store/raw/` is a
    // byte-faithful archive. A deliberately non-canonical body (extra spaces the JSON.stringify
    // normalizer would drop) round-trips identically.
    const verbatim = '{"success":true,  "data":[["РЕГИОН","БРОЙ"],\n["София","5"]]}';
    const raw = await makeClient(() => ({ json: verbatim, rawText: true })).getResourceData('vb');
    expect(raw).toBe(verbatim);
    const parsed = JSON.parse(raw);
    expect(Array.isArray(parsed.data)).toBe(true);
    expect(Array.isArray(parsed.data[0])).toBe(true);
    const orgs = await makeClient(fixtureResponder).listOrganisations();
    expect(orgs.organisations.length).toBeGreaterThan(0);
  });

  it('accepts an empty datastore response with no data field (live {success:true})', async () => {
    // The live API omits `data` for an empty resource — capture stores it verbatim, not a failure.
    const raw = await makeClient(() => ({ json: { success: true } })).getResourceData('empty');
    expect(raw).toBe('{"success":true}');
  });

  it('accepts a plain-string datastore response (free-text/ASCII table)', async () => {
    // Some resources return `data` as a pre-formatted text table (a string), not rows/object.
    const text = '   +----+\n   | No |\n   +----+\n';
    const raw = await makeClient(() => ({ json: { success: true, data: text } })).getResourceData(
      'txt',
    );
    expect(JSON.parse(raw).data).toBe(text);
  });

  it('throws on a {success:false} error envelope from getResourceData', async () => {
    const client = makeClient(() => ({ json: { success: false, error: { type: 'NotFound' } } }));
    await expect(client.getResourceData('x')).rejects.toThrow(
      /egov-bg getResourceData failed: NotFound/,
    );
  });

  it('throws terminally on a non-JSON getResourceData body (e.g. an HTML error page)', async () => {
    const client = makeClient(() => ({ json: '<html>err</html>', rawText: true }));
    await expect(client.getResourceData('x')).rejects.toThrow(/returned non-JSON/);
  });

  it('sends method as the URL path segment and POSTs a JSON body', async () => {
    const captured: Captured[] = [];
    await makeClient(fixtureResponder, captured).listDatasets({ recordsPerPage: 7, pageNumber: 2 });
    expect(captured[0]?.url).toBe('https://data.egov.bg/api/listDatasets');
    expect(captured[0]?.body).toMatchObject({ records_per_page: 7, page_number: 2 });
  });

  it('includes api_key in the body when configured', async () => {
    const captured: Captured[] = [];
    await makeClient(fixtureResponder, captured, 'SECRET').listDatasets();
    expect((captured[0]?.body as { api_key?: string }).api_key).toBe('SECRET');
  });

  it('throws on a {success:false} error envelope', async () => {
    const client = makeClient(() => ({
      json: { success: false, errors: { criteria: ['required'] }, error: { type: 'Обща' } },
    }));
    await expect(client.listResources('x')).rejects.toThrow(/egov-bg listResources failed/);
  });

  it('treats success:false as an error even when error/errors have a non-standard shape', async () => {
    // errors as array, error as string — must still be a CkanApiError, not a
    // misleading "schema violation".
    const client = makeClient(() => ({
      json: { success: false, errors: ['criteria required'], error: 'Invalid api_key' },
    }));
    const err = await client.listDatasets().catch((e) => e);
    expect(err).toBeInstanceOf(CkanApiError);
    expect(err.message).toBe('egov-bg listDatasets failed: Invalid api_key ["criteria required"]');
  });

  it('carries action + falls back to error.type, then to "error"', async () => {
    const typed = makeClient(() => ({ json: { success: false, error: { type: 'NotFound' } } }));
    const e1 = await typed.getDatasetDetails('x').catch((e) => e);
    expect(e1).toBeInstanceOf(CkanApiError);
    expect(e1.message).toBe('egov-bg getDatasetDetails failed: NotFound');
    expect((e1.details as { action?: string }).action).toBe('getDatasetDetails');

    const bare = makeClient(() => ({ json: { success: false } }));
    await expect(bare.listOrganisations()).rejects.toThrow(/listOrganisations failed: error/);
  });

  it('throws a schema violation (success:true but missing required field) with mapped issues', async () => {
    const client = makeClient(() => ({ json: { success: true, datasets: [{ name: 'no-uri' }] } }));
    const err = await client.listDatasets().catch((e) => e);
    expect(err).toBeInstanceOf(CkanApiError);
    expect(err.message).toBe('egov-bg listDatasets schema violation');
    const d = err.details as { action?: string; issues?: Array<{ path: string }> };
    expect(d.action).toBe('listDatasets');
    expect(d.issues?.some((i) => i.path.includes('uri'))).toBe(true);
  });
});
