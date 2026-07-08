import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackoffRunner } from '../../../src/crawler/backoff.ts';
import { captureResource } from '../../../src/crawler/capture-resource.ts';
import { PortalHttp } from '../../../src/crawler/http.ts';
import { RateLimiter } from '../../../src/crawler/rate-limit.ts';
import { RobotsCache } from '../../../src/crawler/robots.ts';
import { BlobStore } from '../../../src/store/blob-store.ts';
import { runMigrations } from '../../../src/store/migrate.ts';
import { DatasetsRepo } from '../../../src/store/repos/datasets.ts';
import { type ResourceRow, ResourcesRepo } from '../../../src/store/repos/resources.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const MIGRATIONS = join(ROOT, 'migrations');

function db(): Database {
  const d = new Database(':memory:');
  d.exec('PRAGMA foreign_keys = ON;');
  runMigrations(d, MIGRATIONS);
  new DatasetsRepo(d).upsert({
    id: 'd1',
    slug: 'd1',
    titleBg: 'A',
    tags: [],
    groups: [],
    sourceUrl: 'https://x/d1',
  });
  return d;
}

function makeHttp(fetcher: typeof fetch): PortalHttp {
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
  return new PortalHttp({
    userAgent: 'danni-bg/test',
    rateLimiter: rate,
    backoff: back,
    robots,
    fetcher,
  });
}

function seedResource(database: Database): ResourceRow {
  const repo = new ResourcesRepo(database);
  return repo.upsert({
    id: 'r1',
    datasetId: 'd1',
    sourceUrl: 'https://example.org/file.csv',
    declaredFormat: 'csv',
  });
}

describe('crawler.capture-resource', () => {
  let database: Database;
  beforeEach(() => {
    database = db();
  });
  afterEach(() => {
    database.close();
  });

  it('captures a fresh resource and records the blob path', async () => {
    const fetcher = (async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.endsWith('/robots.txt')) {
        return new Response('User-agent: *\nAllow: /\n') as unknown as Response;
      }
      return new Response('id,a\n1,2\n', {
        status: 200,
        headers: { 'content-type': 'text/csv', etag: '"v1"' },
      }) as unknown as Response;
    }) as unknown as typeof fetch;
    const http = makeHttp(fetcher);
    const blobStore = new BlobStore({ storeRoot: globalThis.__TEST_TMP_DIR__ });
    const r = seedResource(database);
    const out = await captureResource(
      { db: database, http, blobStore, storeRoot: globalThis.__TEST_TMP_DIR__ },
      r,
    );
    expect(out.kind).toBe('captured');
    if (out.kind === 'captured') {
      expect(out.bytes).toBeGreaterThan(0);
      expect(out.sha256.length).toBe(64);
      expect(out.etag).toBe('"v1"');
    }
    const after = new ResourcesRepo(database).get('r1');
    expect(after?.last_outcome).toBe('success');
  });

  it('returns skipped_unchanged on 304', async () => {
    const fetcher = (async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.endsWith('/robots.txt')) {
        return new Response('User-agent: *\nAllow: /\n') as unknown as Response;
      }
      return new Response(null, { status: 304, headers: { etag: '"v1"' } }) as unknown as Response;
    }) as unknown as typeof fetch;
    const http = makeHttp(fetcher);
    const blobStore = new BlobStore({ storeRoot: globalThis.__TEST_TMP_DIR__ });
    const r = seedResource(database);
    const out = await captureResource(
      { db: database, http, blobStore, storeRoot: globalThis.__TEST_TMP_DIR__ },
      r,
    );
    expect(out.kind).toBe('skipped_unchanged');
    expect(new ResourcesRepo(database).get('r1')?.last_outcome).toBe('skipped_unchanged');
  });

  it('returns failed on an incomplete download (no sha256/bytes/tempPath)', async () => {
    // A download that is neither notModified nor a complete capture — the fall-through failure branch.
    const http = {
      download: async () => ({ notModified: false, status: 200 }),
    } as unknown as PortalHttp;
    const blobStore = new BlobStore({ storeRoot: globalThis.__TEST_TMP_DIR__ });
    const r = seedResource(database);
    const out = await captureResource(
      { db: database, http, blobStore, storeRoot: globalThis.__TEST_TMP_DIR__ },
      r,
    );
    expect(out.kind).toBe('failed');
    if (out.kind === 'failed') expect(out.reason).toBe('incomplete download');
  });

  it('returns failed when the server errors', async () => {
    const fetcher = (async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.endsWith('/robots.txt')) {
        return new Response('User-agent: *\nAllow: /\n') as unknown as Response;
      }
      return new Response('boom', { status: 500 }) as unknown as Response;
    }) as unknown as typeof fetch;
    const http = makeHttp(fetcher);
    const blobStore = new BlobStore({ storeRoot: globalThis.__TEST_TMP_DIR__ });
    const r = seedResource(database);
    const out = await captureResource(
      { db: database, http, blobStore, storeRoot: globalThis.__TEST_TMP_DIR__ },
      r,
    );
    expect(out.kind).toBe('failed');
    expect(new ResourcesRepo(database).get('r1')?.last_outcome).toBe('failure');
  });
});
