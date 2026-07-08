import { afterEach, describe, expect, it } from 'bun:test';
import {
  createApiKey,
  deleteSession,
  getApiUsage,
  getMyUsage,
  getSession,
  listApiKeys,
  listSessions,
  revokeApiKey,
  setMyAvatar,
  stopGeneration,
} from './meApi.ts';

// meApi is a thin typed facade over the shared `request` helper; stub the fetch layer exactly like
// http.test.ts and assert each call's method/URL/credentials + the response-shape unwrapping.

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

describe('meApi — every call is cookie-authed', () => {
  it('getMyUsage GETs the usage endpoint', async () => {
    const cap: Captured = {};
    stub(cap, { used: 5, limit: 0 });
    const out = await getMyUsage();
    expect(out.used).toBe(5);
    expect(cap.url).toBe('/api/me/usage');
    expect(cap.init?.method).toBe('GET');
    expect(cap.init?.credentials).toBe('include');
  });

  it('setMyAvatar PUTs the avatar url as a JSON body', async () => {
    const cap: Captured = {};
    stub(cap, undefined, true, 204);
    await setMyAvatar('https://x/a.png');
    expect(cap.url).toBe('/api/me/avatar');
    expect(cap.init?.method).toBe('PUT');
    expect(cap.init?.body).toBe(JSON.stringify({ avatarUrl: 'https://x/a.png' }));
    expect(cap.init?.credentials).toBe('include');
  });

  it('listSessions unwraps the { sessions } envelope', async () => {
    const cap: Captured = {};
    stub(cap, { sessions: [{ id: 's1', title: 'A', updatedAt: '' }] });
    const out = await listSessions();
    expect(out).toEqual([{ id: 's1', title: 'A', updatedAt: '' }] as never);
    expect(cap.url).toBe('/api/me/sessions');
  });

  it('getSession GETs one conversation by id', async () => {
    const cap: Captured = {};
    stub(cap, { sessionId: 's1', messages: [], contextDatasetIds: [] });
    const out = await getSession('s1');
    expect(out.sessionId).toBe('s1');
    expect(cap.url).toBe('/api/me/sessions/s1');
  });

  it('deleteSession DELETEs a conversation', async () => {
    const cap: Captured = {};
    stub(cap, undefined, true, 204);
    await deleteSession('s1');
    expect(cap.url).toBe('/api/me/sessions/s1');
    expect(cap.init?.method).toBe('DELETE');
  });

  it('stopGeneration POSTs the stop endpoint', async () => {
    const cap: Captured = {};
    stub(cap, undefined, true, 204);
    await stopGeneration('gen-9');
    expect(cap.url).toBe('/api/me/generations/gen-9/stop');
    expect(cap.init?.method).toBe('POST');
  });

  it('stopGeneration swallows a failure (best-effort)', async () => {
    stub({}, {}, false, 500);
    // Must resolve, not reject — a failed stop is non-fatal.
    await expect(stopGeneration('gen-9')).resolves.toBeUndefined();
  });

  it('listApiKeys unwraps the { keys } envelope', async () => {
    const cap: Captured = {};
    stub(cap, { keys: [{ id: 'k1', name: 'ci' }] });
    const out = await listApiKeys();
    expect(out).toEqual([{ id: 'k1', name: 'ci' }] as never);
    expect(cap.url).toBe('/api/me/api-keys');
  });

  it('createApiKey POSTs name + scopes when scopes are given', async () => {
    const cap: Captured = {};
    stub(cap, { id: 'k1', key: 'dnk_live_x' });
    const out = await createApiKey('ci', ['read', 'chat']);
    expect(out.key).toBe('dnk_live_x');
    expect(cap.init?.method).toBe('POST');
    expect(cap.init?.body).toBe(JSON.stringify({ name: 'ci', scopes: ['read', 'chat'] }));
  });

  it('createApiKey omits an empty/absent scopes list', async () => {
    const cap: Captured = {};
    stub(cap, { id: 'k1', key: 'dnk_live_y' });
    await createApiKey('ci', []); // empty array → omitted
    expect(cap.init?.body).toBe(JSON.stringify({ name: 'ci' }));
    await createApiKey('ci2'); // undefined → omitted
    expect(cap.init?.body).toBe(JSON.stringify({ name: 'ci2' }));
  });

  it('revokeApiKey DELETEs a key by id', async () => {
    const cap: Captured = {};
    stub(cap, undefined, true, 204);
    await revokeApiKey('k1');
    expect(cap.url).toBe('/api/me/api-keys/k1');
    expect(cap.init?.method).toBe('DELETE');
  });

  it('getApiUsage GETs the api-usage endpoint', async () => {
    const cap: Captured = {};
    stub(cap, { windowSec: 60, total: 3, data: 2, chat: 1, byKey: [] });
    const out = await getApiUsage();
    expect(out.total).toBe(3);
    expect(cap.url).toBe('/api/me/api-usage');
  });
});
