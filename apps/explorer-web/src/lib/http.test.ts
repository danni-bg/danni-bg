import { afterEach, describe, expect, it } from 'bun:test';
import { HttpError, buildUrl, request } from './http.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Captured {
  url?: string;
  init?: RequestInit;
}

function stub(cap: Captured, body: unknown, ok = true, status = ok ? 200 : 500): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    cap.url = typeof input === 'string' ? input : input.toString();
    cap.init = init;
    return {
      ok,
      status,
      text: async () => (body === undefined ? '' : JSON.stringify(body)),
    } as unknown as Response;
  }) as typeof fetch;
}

describe('buildUrl', () => {
  it('omits the query string when empty', () => {
    expect(buildUrl('/api/x')).toBe('/api/x');
    expect(buildUrl('/api/x', new URLSearchParams({ a: '1' }))).toBe('/api/x?a=1');
  });
});

describe('request', () => {
  it('returns the parsed JSON body on a 2xx response', async () => {
    const cap: Captured = {};
    stub(cap, { ok: true, n: 3 });
    const out = await request<{ ok: boolean; n: number }>('/api/x');
    expect(out).toEqual({ ok: true, n: 3 });
    expect(cap.url).toBe('/api/x');
    expect(cap.init?.method).toBe('GET');
    expect(cap.init?.credentials).toBeUndefined(); // anon GET carries no cookie
  });

  it('throws a typed HttpError on a non-OK response', async () => {
    const cap: Captured = {};
    stub(cap, {}, false, 503);
    const err = await request('/api/x').catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(503);
    expect((err as HttpError).path).toBe('/api/x');
    expect((err as Error).message).toContain('request failed');
  });

  it('sends the session cookie only when authed', async () => {
    const cap: Captured = {};
    stub(cap, { me: 1 });
    await request('/api/me/usage', { authed: true });
    expect(cap.init?.credentials).toBe('include');
  });

  it('serializes a JSON body with the content-type header', async () => {
    const cap: Captured = {};
    stub(cap, { saved: true });
    await request('/api/x', { method: 'PUT', body: { limit: 5 }, authed: true });
    expect(cap.init?.method).toBe('PUT');
    expect(cap.init?.body).toBe(JSON.stringify({ limit: 5 }));
    expect((cap.init?.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(cap.init?.credentials).toBe('include');
  });

  it('appends URLSearchParams to the path', async () => {
    const cap: Captured = {};
    stub(cap, []);
    await request('/api/x', { params: new URLSearchParams({ tags: 't', limit: '10' }) });
    expect(cap.url).toContain('/api/x?');
    expect(cap.url).toContain('tags=t');
    expect(cap.url).toContain('limit=10');
  });

  it('returns undefined for an empty (204/void) body', async () => {
    const cap: Captured = {};
    stub(cap, undefined, true, 204);
    const out = await request<void>('/api/x', { method: 'DELETE', authed: true });
    expect(out).toBeUndefined();
  });
});
