import { describe, expect, it } from 'bun:test';
import { RobotsCache } from '../../../src/crawler/robots.ts';

function staticFetcher(
  map: Record<string, { status: number; body: string }>,
): (url: string) => Promise<{ status: number; body: string }> {
  return async (url) => map[url] ?? { status: 404, body: '' };
}

describe('crawler.RobotsCache', () => {
  it('allows everything when robots.txt is absent', async () => {
    const cache = new RobotsCache({
      recheckIntervalSeconds: 60,
      fetcher: async () => ({ status: 404, body: '' }),
    });
    expect(await cache.isAllowed('https://example.com/api/x', 'agent')).toBe(true);
  });

  it('honors a Disallow rule', async () => {
    const cache = new RobotsCache({
      recheckIntervalSeconds: 60,
      fetcher: staticFetcher({
        'https://example.com/robots.txt': {
          status: 200,
          body: 'User-agent: *\nDisallow: /private\n',
        },
      }),
    });
    expect(await cache.isAllowed('https://example.com/private/x', 'agent')).toBe(false);
    expect(await cache.isAllowed('https://example.com/public/x', 'agent')).toBe(true);
  });

  it('honors a more specific Allow over a Disallow', async () => {
    const cache = new RobotsCache({
      recheckIntervalSeconds: 60,
      fetcher: staticFetcher({
        'https://example.com/robots.txt': {
          status: 200,
          body: 'User-agent: *\nDisallow: /api/\nAllow: /api/public/\n',
        },
      }),
    });
    expect(await cache.isAllowed('https://example.com/api/public/x', 'agent')).toBe(true);
    expect(await cache.isAllowed('https://example.com/api/private/x', 'agent')).toBe(false);
  });

  it('matches user-agent group', async () => {
    const cache = new RobotsCache({
      recheckIntervalSeconds: 60,
      fetcher: staticFetcher({
        'https://example.com/robots.txt': {
          status: 200,
          body: 'User-agent: danni-bg\nDisallow: /\nUser-agent: *\nAllow: /\n',
        },
      }),
    });
    expect(await cache.isAllowed('https://example.com/x', 'danni-bg/0.1.0')).toBe(false);
    expect(await cache.isAllowed('https://example.com/x', 'OtherBot')).toBe(true);
  });

  it('caches and re-checks after the configured interval', async () => {
    let now = 0;
    let calls = 0;
    const cache = new RobotsCache({
      recheckIntervalSeconds: 60,
      now: () => now,
      fetcher: async () => {
        calls++;
        return { status: 200, body: 'User-agent: *\n' };
      },
    });
    await cache.isAllowed('https://example.com/x', 'a');
    await cache.isAllowed('https://example.com/y', 'a');
    expect(calls).toBe(1);
    now += 61_000;
    await cache.isAllowed('https://example.com/z', 'a');
    expect(calls).toBe(2);
  });

  it('returns age in seconds, undefined for unseen origins', async () => {
    let now = 0;
    const cache = new RobotsCache({
      recheckIntervalSeconds: 60,
      now: () => now,
      fetcher: async () => ({ status: 200, body: '' }),
    });
    expect(await cache.ageSeconds('https://example.com')).toBeUndefined();
    await cache.isAllowed('https://example.com/x', 'a');
    now += 5000;
    expect(await cache.ageSeconds('https://example.com')).toBe(5);
  });

  it('rejects malformed URLs', async () => {
    const cache = new RobotsCache({
      recheckIntervalSeconds: 60,
      fetcher: async () => ({ status: 200, body: '' }),
    });
    expect(await cache.isAllowed('not-a-url', 'a')).toBe(false);
  });

  it('opt-out (obey=false) allows everything without fetching robots.txt', async () => {
    let fetched = false;
    const cache = new RobotsCache({
      recheckIntervalSeconds: 60,
      obey: false,
      fetcher: async () => {
        fetched = true;
        return { status: 200, body: 'User-agent: *\nDisallow: /\n' };
      },
    });
    // A site whose robots.txt blanket-disallows is still allowed under opt-out,
    // and robots.txt is never even fetched.
    expect(await cache.isAllowed('https://data.egov.bg/api/listDatasets', 'danni')).toBe(true);
    expect(fetched).toBe(false);
  });

  it('allowHosts exempts a specific host while still enforcing robots elsewhere', async () => {
    const cache = new RobotsCache({
      recheckIntervalSeconds: 60,
      allowHosts: ['data.egov.bg'],
      fetcher: async () => ({ status: 200, body: 'User-agent: *\nDisallow: /\n' }),
    });
    expect(await cache.isAllowed('https://data.egov.bg/api/x', 'danni')).toBe(true);
    // A different host with the same blanket-disallow is still blocked.
    expect(await cache.isAllowed('https://other.example/x', 'danni')).toBe(false);
  });

  it('uses the built-in fetcher (global fetch) when none is injected', async () => {
    const original = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (url: string) => {
      seen.push(String(url));
      return new Response('User-agent: *\nDisallow: /blocked\n', { status: 200 });
    }) as typeof fetch;
    try {
      const cache = new RobotsCache({ recheckIntervalSeconds: 60 });
      expect(await cache.isAllowed('https://example.com/blocked/x', 'danni')).toBe(false);
      expect(await cache.isAllowed('https://example.com/ok/x', 'danni')).toBe(true);
      expect(seen).toContain('https://example.com/robots.txt');
    } finally {
      globalThis.fetch = original;
    }
  });
});
