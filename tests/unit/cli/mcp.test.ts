import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dispatchLine, run, runStdio } from '../../../src/cli/mcp.ts';
import { LocalOnnxEmbedder } from '../../../src/index/embedders/local-onnx.ts';
import type { McpContext } from '../../../src/mcp/server.ts';
import { runMigrations } from '../../../src/store/migrate.ts';

const MIGRATIONS = fileURLToPath(new URL('../../../migrations', import.meta.url));

function makeCtx(): McpContext {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db, MIGRATIONS);
  return {
    db,
    storeRoot: globalThis.__TEST_TMP_DIR__,
    embedder: new LocalOnnxEmbedder({ dimension: 8 }),
    freshnessSloSeconds: 86400,
  };
}

async function* chunks(...parts: string[]): AsyncIterable<Uint8Array> {
  const enc = new TextEncoder();
  for (const p of parts) yield enc.encode(p);
}

describe('cli.mcp dispatchLine', () => {
  let ctx: McpContext;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => ctx.db.close());

  it('dispatches a valid JSON-RPC line', async () => {
    const r = await dispatchLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }), ctx);
    expect(r?.result).toEqual({});
  });

  it('returns a -32700 parse error (id null) on malformed JSON', async () => {
    const r = await dispatchLine('{not json', ctx);
    expect(r?.error?.code).toBe(-32700);
    expect(r?.id).toBeNull();
  });
});

describe('cli.mcp runStdio', () => {
  let ctx: McpContext;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => ctx.db.close());

  it('frames newline-delimited messages across chunk boundaries and emits nothing for notifications', async () => {
    const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    const notif = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const list = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const out: string[] = [];
    // First message is split across two chunks to exercise the buffer.
    await runStdio(ctx, chunks(init.slice(0, 12), `${init.slice(12)}\n${notif}\n${list}\n`), (s) =>
      out.push(s),
    );
    expect(out.length).toBe(2); // init + list responses; the notification produces no output
    expect(JSON.parse(out[0] ?? '{}').id).toBe(1);
    expect(JSON.parse(out[1] ?? '{}').id).toBe(2);
  });

  it('processes a final message that has no trailing newline', async () => {
    const out: string[] = [];
    await runStdio(ctx, chunks(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' })), (s) =>
      out.push(s),
    );
    expect(out.length).toBe(1);
    expect(JSON.parse(out[0] ?? '{}').id).toBe(7);
  });

  it('runStdio writes to stdout by default when no write sink is given', async () => {
    const orig = process.stdout.write;
    const seen: string[] = [];
    process.stdout.write = ((chunk: string | Uint8Array) => {
      seen.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      await runStdio(ctx, chunks(`${JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' })}\n`));
    } finally {
      process.stdout.write = orig;
    }
    expect(JSON.parse(seen.join('') || '{}').id).toBe(9);
  });
});

describe('cli.mcp run()', () => {
  function configFile(storeRoot: string): string {
    const cfgPath = join(
      globalThis.__TEST_TMP_DIR__,
      `mcp-${Math.random().toString(36).slice(2)}.json`,
    );
    writeFileSync(
      cfgPath,
      JSON.stringify({
        portal: { baseUrl: 'https://data.egov.bg/api/3/action/' },
        crawler: {
          userAgent: 'danni-bg/test',
          rateLimit: { requestsPerSecondPerHost: 1 },
          concurrency: { maxConcurrentRequestsPerHost: 4 },
          backoff: { initialMs: 500, maxMs: 60000, failureBudget: 20 },
          robots: { recheckIntervalSeconds: 86400 },
        },
        store: { root: storeRoot },
        schedule: {
          enabled: false,
          cron: null,
          onOverlap: 'skip',
          failureRateThreshold: 0.05,
          notifier: { kind: 'stderr' },
        },
        scope: {},
        enrichment: {
          translator: { provider: 'local-marianmt' },
          embedder: { provider: 'local-onnx', batchSize: 32 },
        },
        index: { incremental: true },
      }),
    );
    return cfgPath;
  }

  async function withEnv<T>(cfg: string, fn: () => Promise<T>): Promise<T> {
    const prev = process.env.DANNI_CONFIG;
    process.env.DANNI_CONFIG = cfg;
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.DANNI_CONFIG;
      else process.env.DANNI_CONFIG = prev;
    }
  }

  it('prints help and returns 0', async () => {
    const orig = process.stdout.write;
    const seen: string[] = [];
    process.stdout.write = ((c: string | Uint8Array) => {
      seen.push(typeof c === 'string' ? c : Buffer.from(c).toString());
      return true;
    }) as typeof process.stdout.write;
    let code: number;
    try {
      code = await run(['--help']);
    } finally {
      process.stdout.write = orig;
    }
    expect(code).toBe(0);
    expect(seen.join('')).toContain('Model Context Protocol');
  });

  it('opens the store, runs the stdio loop over a finite input, and returns 0', async () => {
    const storeRoot = join(
      globalThis.__TEST_TMP_DIR__,
      `store-${Math.random().toString(36).slice(2)}`,
    );
    const { openDb } = await import('../../../src/store/db.ts');
    const seed = openDb({ storeRoot, loadVec: false });
    runMigrations(seed, MIGRATIONS);
    seed.close();
    const cfg = configFile(storeRoot);

    const orig = process.stdout.write;
    const seen: string[] = [];
    process.stdout.write = ((c: string | Uint8Array) => {
      seen.push(typeof c === 'string' ? c : Buffer.from(c).toString());
      return true;
    }) as typeof process.stdout.write;
    let code: number;
    try {
      code = await withEnv(cfg, () =>
        run([], chunks(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' })}\n`)),
      );
    } finally {
      process.stdout.write = orig;
    }
    expect(code).toBe(0);
    expect(JSON.parse(seen.join('') || '{}').id).toBe(3);
  });
});
