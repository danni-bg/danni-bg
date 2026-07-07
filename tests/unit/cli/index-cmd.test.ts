import { afterEach, describe, expect, it } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFlags, resolveMode, run } from '../../../src/cli/index-cmd.ts';
import type { DanniConfig } from '../../../src/config/schema.ts';

function cfg(incremental: boolean): DanniConfig['index'] {
  return { incremental };
}

function emb(
  over: Partial<DanniConfig['enrichment']['embedder']> = {},
): DanniConfig['enrichment']['embedder'] {
  return { provider: 'local-onnx', batchSize: 32, ...over };
}

describe('cli.index-cmd parseFlags', () => {
  it('parses --full', () => {
    expect(parseFlags(['--full']).full).toBe(true);
  });

  it('parses --datasets into a trimmed list', () => {
    expect(parseFlags(['--datasets', 'a, b ,c']).datasets).toEqual(['a', 'b', 'c']);
  });

  it('throws when --datasets has no value', () => {
    expect(() => parseFlags(['--datasets'])).toThrow();
  });

  it('throws __HELP__ on --help', () => {
    expect(() => parseFlags(['--help'])).toThrow('__HELP__');
  });

  it('throws on an unknown flag', () => {
    expect(() => parseFlags(['--nope'])).toThrow(/unknown flag/);
  });
});

describe('cli.index-cmd resolveMode (FR-009 precedence)', () => {
  it('--full overrides config (full:true, incremental:true is moot)', () => {
    const m = resolveMode({ full: true }, cfg(false));
    expect(m.full).toBe(true);
  });

  it('config.incremental=false (no --full) → incremental:false', () => {
    const m = resolveMode({}, cfg(false));
    expect(m.full).toBeUndefined();
    expect(m.incremental).toBe(false);
  });

  it('default (config true, no flag) → incremental:true', () => {
    const m = resolveMode({}, cfg(true));
    expect(m.incremental).toBe(true);
  });

  it('--full takes precedence over config=true too', () => {
    const m = resolveMode({ full: true }, cfg(true));
    expect(m.full).toBe(true);
  });

  it('passes through a --datasets subset', () => {
    const m = resolveMode({ datasets: ['x', 'y'] }, cfg(true));
    expect(m.datasetIds).toEqual(['x', 'y']);
  });

  it('omits datasetIds when no subset given', () => {
    const m = resolveMode({}, cfg(true));
    expect(m.datasetIds).toBeUndefined();
  });
});

describe('cli.index-cmd resolveMode batch sizes (T032, FR-002)', () => {
  it('threads config batchSize into the loop options', () => {
    const m = resolveMode({}, cfg(true), emb({ batchSize: 64 }));
    expect(m.batchSize).toBe(64);
  });

  it('threads a config maxBatchSize cap', () => {
    const m = resolveMode({}, cfg(true), emb({ batchSize: 64, maxBatchSize: 16 }));
    expect(m.maxBatchSize).toBe(16);
  });

  it('omits maxBatchSize when unset (no cap)', () => {
    const m = resolveMode({}, cfg(true), emb({ batchSize: 64 }));
    expect(m.maxBatchSize).toBeUndefined();
  });

  it('omits maxBatchSize when explicitly null', () => {
    const m = resolveMode({}, cfg(true), emb({ batchSize: 64, maxBatchSize: null }));
    expect(m.maxBatchSize).toBeUndefined();
  });

  it('omits batch sizes entirely when no embedder is passed (back-compat)', () => {
    const m = resolveMode({}, cfg(true));
    expect(m.batchSize).toBeUndefined();
    expect(m.maxBatchSize).toBeUndefined();
  });
});

describe('cli.index-cmd run() wiring (T031)', () => {
  const captured: string[] = [];
  let origWrite: typeof process.stdout.write;
  afterEach(() => {
    if (origWrite) process.stdout.write = origWrite;
  });

  function configFile(storeRoot: string): string {
    const cfgPath = join(
      globalThis.__TEST_TMP_DIR__,
      `idx-${Math.random().toString(36).slice(2)}.json`,
    );
    writeFileSync(
      cfgPath,
      JSON.stringify({
        portal: { baseUrl: 'https://data.egov.bg/api/3/action/' },
        crawler: {
          userAgent: 'danni-bg/test (+local)',
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
          embedder: { provider: 'local-onnx', batchSize: 64 },
        },
        index: { incremental: true },
      }),
    );
    return cfgPath;
  }

  it('runs an empty store and serializes the extended RunIndexResult (the four 002 counts + failures[])', async () => {
    const storeRoot = join(
      globalThis.__TEST_TMP_DIR__,
      `store-${Math.random().toString(36).slice(2)}`,
    );
    const cfgPath = configFile(storeRoot);
    // Migrate the temp store so runIndex has its tables.
    const { runMigrations } = await import('../../../src/store/migrate.ts');
    const { openDb } = await import('../../../src/store/db.ts');
    const { fileURLToPath } = await import('node:url');
    const migrations = fileURLToPath(new URL('../../../migrations', import.meta.url));
    const seed = openDb({ storeRoot, loadVec: false });
    runMigrations(seed, migrations);
    seed.close();

    captured.length = 0;
    origWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write;

    const prevEnv = process.env.DANNI_CONFIG;
    process.env.DANNI_CONFIG = cfgPath;
    let code: number;
    try {
      code = await run([]);
    } finally {
      if (prevEnv === undefined) delete process.env.DANNI_CONFIG;
      else process.env.DANNI_CONFIG = prevEnv;
    }
    expect(code).toBe(0);
    const out = JSON.parse(captured.join(''));
    expect(out).toHaveProperty('embedderRequests');
    expect(out).toHaveProperty('skippedEmpty');
    expect(out).toHaveProperty('failed');
    expect(out).toHaveProperty('failures');
    expect(out.failures).toEqual([]);
  });

  it('returns 2 and writes to stderr on a bad flag (parseFlags failure)', async () => {
    const code = await run(['--nope']);
    expect(code).toBe(2);
  });

  it('returns 0 on --help', async () => {
    const code = await run(['--help']);
    expect(code).toBe(0);
  });
});
