import { afterEach, describe, expect, it } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlags, run } from '../../../src/cli/eval.ts';

const MIGRATIONS = fileURLToPath(new URL('../../../migrations', import.meta.url));

describe('cli.eval parseFlags', () => {
  it('requires --query-set', () => {
    expect(() => parseFlags([])).toThrow(/query-set/);
    expect(() => parseFlags(['--query-set'])).toThrow(/query-set/);
  });

  it('rejects --query-set when the next token is another flag', () => {
    expect(() => parseFlags(['--query-set', '--limit', '5'])).toThrow(/query-set/);
  });

  it('parses all flags', () => {
    const f = parseFlags([
      '--query-set',
      'q.json',
      '--limit',
      '3',
      '--min-recall',
      '0.9',
      '--json',
    ]);
    expect(f).toEqual({ querySet: 'q.json', limit: 3, minRecall: 0.9, json: true });
  });

  it('rejects an out-of-range --limit', () => {
    expect(() => parseFlags(['--query-set', 'q', '--limit', '99'])).toThrow(/--limit/);
  });

  it('rejects an out-of-range --min-recall', () => {
    expect(() => parseFlags(['--query-set', 'q', '--min-recall', '2'])).toThrow(/--min-recall/);
  });

  it('throws __HELP__ on --help and rejects unknown flags', () => {
    expect(() => parseFlags(['--help'])).toThrow('__HELP__');
    expect(() => parseFlags(['--nope'])).toThrow(/unknown flag/);
  });
});

describe('cli.eval run() (T-eval)', () => {
  const captured: string[] = [];
  let origWrite: typeof process.stdout.write;
  afterEach(() => {
    if (origWrite) process.stdout.write = origWrite;
  });

  function configFile(storeRoot: string): string {
    const cfgPath = join(
      globalThis.__TEST_TMP_DIR__,
      `cfg-${Math.random().toString(36).slice(2)}.json`,
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

  async function seedStore(storeRoot: string): Promise<void> {
    const { openDb } = await import('../../../src/store/db.ts');
    const { runMigrations } = await import('../../../src/store/migrate.ts');
    const { DatasetsRepo } = await import('../../../src/store/repos/datasets.ts');
    const { runIndex } = await import('../../../src/index/run-index.ts');
    const { LocalOnnxEmbedder } = await import('../../../src/index/embedders/local-onnx.ts');
    const db = openDb({ storeRoot, loadVec: false });
    runMigrations(db, MIGRATIONS);
    new DatasetsRepo(db).upsert({
      id: 'd-budget',
      slug: 'd-budget',
      titleBg: 'Бюджет на София',
      tags: [],
      groups: [],
      sourceUrl: 'https://data.egov.bg/data/view/d-budget',
    });
    await runIndex({ db, embedder: new LocalOnnxEmbedder() });
    db.close();
  }

  function writeQuerySet(name: string, queries: unknown): string {
    const p = join(globalThis.__TEST_TMP_DIR__, name);
    writeFileSync(p, JSON.stringify({ queries }));
    return p;
  }

  async function withConfig<T>(cfgPath: string, fn: () => Promise<T>): Promise<T> {
    const prev = process.env.DANNI_CONFIG;
    process.env.DANNI_CONFIG = cfgPath;
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.DANNI_CONFIG;
      else process.env.DANNI_CONFIG = prev;
    }
  }

  function captureStdout(): void {
    captured.length = 0;
    origWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write;
  }

  it('reports recall and exits 0 when the query hits', async () => {
    const storeRoot = join(
      globalThis.__TEST_TMP_DIR__,
      `store-${Math.random().toString(36).slice(2)}`,
    );
    await seedStore(storeRoot);
    const qs = writeQuerySet('hit.json', [{ query: 'бюджет', lang: 'bg', expected: ['d-budget'] }]);
    const cfg = configFile(storeRoot);
    captureStdout();
    const code = await withConfig(cfg, () => run(['--query-set', qs]));
    expect(code).toBe(0);
    expect(captured.join('')).toContain('recall@5');
  });

  it('emits a parseable JSON report honoring --limit', async () => {
    const storeRoot = join(
      globalThis.__TEST_TMP_DIR__,
      `store-${Math.random().toString(36).slice(2)}`,
    );
    await seedStore(storeRoot);
    const qs = writeQuerySet('json.json', [
      { query: 'бюджет', lang: 'bg', expected: ['d-budget'] },
    ]);
    const cfg = configFile(storeRoot);
    captureStdout();
    const code = await withConfig(cfg, () => run(['--query-set', qs, '--json', '--limit', '3']));
    expect(code).toBe(0);
    const report = JSON.parse(captured.join('')) as {
      limit: number;
      total: number;
      hits: number;
      recallAtK: number;
      byLang: { bg: { total: number }; en: { total: number } };
      misses: unknown[];
    };
    expect(report.limit).toBe(3);
    expect(report.total).toBe(1);
    expect(report.hits).toBe(1);
    expect(report.recallAtK).toBe(1);
    expect(report.byLang.bg.total).toBe(1);
    expect(Array.isArray(report.misses)).toBe(true);
  });

  it('exits 3 when recall@K is below --min-recall', async () => {
    const storeRoot = join(
      globalThis.__TEST_TMP_DIR__,
      `store-${Math.random().toString(36).slice(2)}`,
    );
    await seedStore(storeRoot);
    const qs = writeQuerySet('miss.json', [
      { query: 'нещо-несъществуващо', lang: 'bg', expected: ['d-not-here'] },
    ]);
    const cfg = configFile(storeRoot);
    captureStdout();
    const code = await withConfig(cfg, () => run(['--query-set', qs, '--min-recall', '0.9']));
    expect(code).toBe(3);
  });

  it('exits 2 when the query-set file is missing or invalid', async () => {
    const cfg = configFile(join(globalThis.__TEST_TMP_DIR__, 'unused-store'));
    const code = await withConfig(cfg, () =>
      run(['--query-set', join(globalThis.__TEST_TMP_DIR__, 'does-not-exist.json')]),
    );
    expect(code).toBe(2);
  });
});
