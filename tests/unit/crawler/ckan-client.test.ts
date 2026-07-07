import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackoffRunner } from '../../../src/crawler/backoff.ts';
import { CkanClient } from '../../../src/crawler/ckan-client.ts';
import { PortalHttp } from '../../../src/crawler/http.ts';
import { RateLimiter } from '../../../src/crawler/rate-limit.ts';
import { RobotsCache } from '../../../src/crawler/robots.ts';

const FIX = fileURLToPath(new URL('../../fixtures/portal/', import.meta.url));

function makeFetcher(routes: Record<string, () => Response>): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (u.endsWith('/robots.txt')) {
      return new Response('User-agent: *\nAllow: /\n') as unknown as Response;
    }
    for (const [pattern, factory] of Object.entries(routes)) {
      if (u.includes(pattern)) return factory();
    }
    return new Response('not found', { status: 404 }) as unknown as Response;
  }) as unknown as typeof fetch;
}

function makeClient(fetcher: typeof fetch): CkanClient {
  const rate = new RateLimiter({ requestsPerSecond: 100, concurrency: 4 });
  const back = new BackoffRunner({
    initialMs: 10,
    maxMs: 100,
    failureBudget: 1,
    sleep: async () => undefined,
  });
  const robots = new RobotsCache({
    recheckIntervalSeconds: 86400,
    fetcher: async () => ({ status: 200, body: 'User-agent: *\nAllow: /\n' }),
  });
  const http = new PortalHttp({
    userAgent: 'danni-bg/test',
    rateLimiter: rate,
    backoff: back,
    robots,
    fetcher,
  });
  return new CkanClient({ baseUrl: 'https://data.egov.bg/api/3/action/', http });
}

describe('crawler.ckan-client', () => {
  let client: CkanClient;
  beforeEach(() => {
    client = makeClient(
      makeFetcher({
        package_list: () =>
          new Response(readFileSync(join(FIX, 'package_list/standard.json'), 'utf-8'), {
            status: 200,
          }) as unknown as Response,
        package_show: () =>
          new Response(readFileSync(join(FIX, 'package_show/standard.json'), 'utf-8'), {
            status: 200,
          }) as unknown as Response,
        organization_show: () =>
          new Response(readFileSync(join(FIX, 'organization_show/standard.json'), 'utf-8'), {
            status: 200,
          }) as unknown as Response,
        organization_list: () =>
          new Response(
            JSON.stringify({
              success: true,
              result: [{ id: 'p1', name: 'p1', title: 'A', description: null }],
            }),
            { status: 200 },
          ) as unknown as Response,
        group_show: () =>
          new Response(readFileSync(join(FIX, 'group_show/standard.json'), 'utf-8'), {
            status: 200,
          }) as unknown as Response,
        group_list: () =>
          new Response(
            JSON.stringify({
              success: true,
              result: [{ id: 'g1', name: 'g1', title: 'G' }],
            }),
            { status: 200 },
          ) as unknown as Response,
        tag_list: () =>
          new Response(readFileSync(join(FIX, 'tag_list/standard.json'), 'utf-8'), {
            status: 200,
          }) as unknown as Response,
      }),
    );
  });
  afterEach(() => undefined);

  it('packageList parses', async () => {
    const out = await client.packageList();
    expect(out.success).toBe(true);
    expect(out.result.length).toBeGreaterThan(0);
  });

  it('organizationList parses', async () => {
    const out = await client.organizationList();
    expect(out.success).toBe(true);
    expect(out.result[0]?.id).toBe('p1');
  });

  it('organizationShow parses', async () => {
    const out = await client.organizationShow('p1');
    expect(out.result.title).toBe('Столична община');
  });

  it('groupShow parses', async () => {
    const out = await client.groupShow('g1');
    expect(out.result.name).toBe('finansi');
  });

  it('groupList parses', async () => {
    const out = await client.groupList();
    expect(out.success).toBe(true);
    expect(out.result[0]?.name).toBe('g1');
  });

  it('tagList parses', async () => {
    const out = await client.tagList();
    expect(out.success).toBe(true);
  });

  it('throws PortalApiError on error envelope', async () => {
    const badClient = makeClient(
      makeFetcher({
        package_show: () =>
          new Response(
            JSON.stringify({
              success: false,
              error: { __type: 'Not Found Error', message: 'no' },
            }),
            { status: 404 },
          ) as unknown as Response,
      }),
    );
    await expect(badClient.packageShow('missing')).rejects.toThrow();
  });

  it('throws PortalApiError on schema violation', async () => {
    const badClient = makeClient(
      makeFetcher({
        package_show: () =>
          new Response(JSON.stringify({ unexpected: true }), {
            status: 200,
          }) as unknown as Response,
      }),
    );
    await expect(badClient.packageShow('whatever')).rejects.toThrow();
  });
});
