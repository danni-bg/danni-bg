import { describe, expect, it } from 'bun:test';
import { buildTranslator, parseFlags, run } from '../../../src/cli/curate.ts';
import { parseConfig } from '../../../src/config/loader.ts';
import { HostedApiTranslator } from '../../../src/enrich/translators/hosted-api.ts';
import { LocalMarianMtTranslator } from '../../../src/enrich/translators/local-marianmt.ts';
import {
  baseConfig,
  captureIO,
  tmpStore,
  withConfig,
  withMigratedStore,
  writeConfig,
} from './_cli-fixture.ts';

function configWithTranslator(translator: Record<string, unknown>): ReturnType<typeof parseConfig> {
  const raw = baseConfig(tmpStore());
  (raw.enrichment as { translator: unknown }).translator = translator;
  return parseConfig(raw);
}

describe('cli.curate parseFlags', () => {
  it('parses every flag', () => {
    const f = parseFlags([
      '--datasets',
      'a, b',
      '--since',
      '2026-01-01',
      '--curator-version',
      '9.9',
      '--entities-only',
    ]);
    expect(f).toEqual({
      datasets: ['a', 'b'],
      since: '2026-01-01',
      curatorVersion: '9.9',
      entitiesOnly: true,
    });
  });
  it('throws when value-taking flags have no value', () => {
    expect(() => parseFlags(['--datasets'])).toThrow(/--datasets/);
    expect(() => parseFlags(['--since'])).toThrow(/--since/);
    expect(() => parseFlags(['--curator-version'])).toThrow(/--curator-version/);
  });
  it('throws __HELP__ on --help and rejects unknown flags', () => {
    expect(() => parseFlags(['--help'])).toThrow('__HELP__');
    expect(() => parseFlags(['--nope'])).toThrow(/unknown flag/);
  });
});

describe('cli.curate buildTranslator', () => {
  it('builds a hosted-api translator with bearer + model', () => {
    process.env.CURATE_TEST_KEY = 'secret';
    try {
      const t = buildTranslator(
        configWithTranslator({
          provider: 'hosted-api',
          endpointUrl: 'https://tx.example/translate',
          apiKeyEnv: 'CURATE_TEST_KEY',
          modelId: 'm-1',
        }),
      );
      expect(t).toBeInstanceOf(HostedApiTranslator);
    } finally {
      delete process.env.CURATE_TEST_KEY;
    }
  });
  it('builds a hosted-api translator without bearer/model', () => {
    const t = buildTranslator(
      configWithTranslator({ provider: 'hosted-api', endpointUrl: 'https://tx.example/translate' }),
    );
    expect(t).toBeInstanceOf(HostedApiTranslator);
  });
  it('throws when hosted-api has no endpointUrl', () => {
    expect(() => buildTranslator(configWithTranslator({ provider: 'hosted-api' }))).toThrow(
      /endpointUrl is required/,
    );
  });
  it('builds a local translator with and without modelId', () => {
    expect(
      buildTranslator(configWithTranslator({ provider: 'local-marianmt', modelId: 'v2' })),
    ).toBeInstanceOf(LocalMarianMtTranslator);
    expect(buildTranslator(configWithTranslator({ provider: 'local-marianmt' }))).toBeInstanceOf(
      LocalMarianMtTranslator,
    );
  });
});

describe('cli.curate run()', () => {
  function seededConfig(translator?: Record<string, unknown>): string {
    const storeRoot = tmpStore();
    withMigratedStore(storeRoot, () => {});
    const raw = baseConfig(storeRoot);
    if (translator) (raw.enrichment as { translator: unknown }).translator = translator;
    return writeConfig(raw);
  }

  it('returns 0 on --help and 2 on a parse error', async () => {
    const io = captureIO();
    try {
      expect(await run(['--help'])).toBe(0);
      expect(await run(['--nope'])).toBe(2);
    } finally {
      io.restore();
    }
  });

  it('curates an empty store (entities-only, no translator) and prints the result', async () => {
    const cfg = seededConfig();
    const io = captureIO();
    try {
      expect(await withConfig(cfg, () => run(['--entities-only']))).toBe(0);
    } finally {
      io.restore();
    }
    expect(() => JSON.parse(io.out.join(''))).not.toThrow();
  });

  it('curates an empty store building a (local) translator', async () => {
    const cfg = seededConfig();
    const io = captureIO();
    try {
      expect(await withConfig(cfg, () => run([]))).toBe(0);
    } finally {
      io.restore();
    }
  });

  it('returns 4 when curation throws (hosted-api translator missing endpointUrl)', async () => {
    const cfg = seededConfig({ provider: 'hosted-api' });
    const io = captureIO();
    try {
      expect(await withConfig(cfg, () => run([]))).toBe(4);
    } finally {
      io.restore();
    }
    expect(io.err.join('')).toContain('endpointUrl is required');
  });
});
