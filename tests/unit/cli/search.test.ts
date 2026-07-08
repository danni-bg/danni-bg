import { describe, expect, it } from 'bun:test';
import { parseFlags, run } from '../../../src/cli/search.ts';
import { LocalOnnxEmbedder } from '../../../src/index/embedders/local-onnx.ts';
import { runIndex } from '../../../src/index/run-index.ts';
import { DatasetsRepo } from '../../../src/store/repos/datasets.ts';
import { baseConfig, captureIO, tmpStore, withConfig, writeConfig } from './_cli-fixture.ts';

async function seededConfig(): Promise<string> {
  const storeRoot = tmpStore();
  await (async () => {
    const { openDb } = await import('../../../src/store/db.ts');
    const { runMigrations } = await import('../../../src/store/migrate.ts');
    const { MIGRATIONS } = await import('./_cli-fixture.ts');
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
  })();
  return writeConfig(baseConfig(storeRoot));
}

describe('cli.search parseFlags', () => {
  it('parses --lang, --limit, --json and a multi-word query', () => {
    const f = parseFlags(['бюджет', 'софия', '--lang', 'bg', '--limit', '3', '--json']);
    expect(f.query).toBe('бюджет софия');
    expect(f.lang).toBe('bg');
    expect(f.limit).toBe(3);
    expect(f.json).toBe(true);
  });
  it('rejects a bad --lang and a bad --limit', () => {
    expect(() => parseFlags(['q', '--lang', 'xx'])).toThrow(/--lang/);
    expect(() => parseFlags(['q', '--limit', '99'])).toThrow(/--limit/);
  });
  it('throws __HELP__ on --help, rejects unknown flags, and requires a query', () => {
    expect(() => parseFlags(['--help'])).toThrow('__HELP__');
    expect(() => parseFlags(['--nope'])).toThrow(/unknown flag/);
    expect(() => parseFlags([])).toThrow(/missing query/);
  });
});

describe('cli.search run()', () => {
  it('returns 0 on --help and 2 on a parse error', async () => {
    const io = captureIO();
    try {
      expect(await run(['--help'])).toBe(0);
      expect(await run(['--nope'])).toBe(2);
    } finally {
      io.restore();
    }
  });

  it('prints human hits for a matching query', async () => {
    const cfg = await seededConfig();
    const io = captureIO();
    try {
      expect(await withConfig(cfg, () => run(['бюджет', '--lang', 'bg']))).toBe(0);
    } finally {
      io.restore();
    }
    expect(io.out.join('')).toContain('d-budget');
  });

  it('emits JSON with --json', async () => {
    const cfg = await seededConfig();
    const io = captureIO();
    try {
      expect(await withConfig(cfg, () => run(['бюджет', '--json', '--limit', '5']))).toBe(0);
    } finally {
      io.restore();
    }
    const results = JSON.parse(io.out.join('')) as unknown[];
    expect(Array.isArray(results)).toBe(true);
  });
});
