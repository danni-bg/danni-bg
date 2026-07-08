import { describe, expect, it } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFlags, parseScopeArg, run } from '../../../src/cli/sync.ts';
import type { RunPortalSyncResult } from '../../../src/crawler/portal-sync.ts';
import { LockContentionError } from '../../../src/manifest/sync-run.ts';
import {
  baseConfig,
  captureIO,
  tmpStore,
  withConfig,
  withMigratedStore,
  writeConfig,
} from './_cli-fixture.ts';

function seededConfig(): string {
  const storeRoot = tmpStore();
  withMigratedStore(storeRoot, () => {});
  return writeConfig(baseConfig(storeRoot));
}

describe('cli.sync parseScopeArg', () => {
  it('returns undefined for no arg', () => {
    expect(parseScopeArg(undefined)).toBeUndefined();
  });
  it('parses inline JSON', () => {
    expect(parseScopeArg('{"datasetIds":["a"]}')?.datasetIds).toEqual(['a']);
  });
  it('reads @file JSON', () => {
    const p = join(globalThis.__TEST_TMP_DIR__, 'scope.json');
    writeFileSync(p, JSON.stringify({ datasetIds: ['x'] }));
    expect(parseScopeArg(`@${p}`)?.datasetIds).toEqual(['x']);
  });
  it('throws on invalid JSON', () => {
    expect(() => parseScopeArg('{not json')).toThrow(/not valid JSON/);
  });
  it('throws a readable message on schema-invalid scope (ZodError path)', () => {
    expect(() => parseScopeArg('{"datasetIds":123}')).toThrow(/failed validation/);
  });
});

describe('cli.sync parseFlags', () => {
  it('accepts --once and parses all flags', () => {
    const f = parseFlags([
      '--once',
      '--dry-run',
      '--retry-failed',
      '--scope',
      '{"datasetIds":["a"]}',
      '--max',
      '5',
      '--manifest-out',
      'm.json',
    ]);
    expect(f.dryRun).toBe(true);
    expect(f.retryFailed).toBe(true);
    expect(f.scope?.datasetIds).toEqual(['a']);
    expect(f.max).toBe(5);
    expect(f.manifestOut).toBe('m.json');
  });
  it('rejects a non-positive --max', () => {
    expect(() => parseFlags(['--max', '0'])).toThrow(/positive integer/);
  });
  it('throws __HELP__ on --help and rejects unknown flags', () => {
    expect(() => parseFlags(['--help'])).toThrow('__HELP__');
    expect(() => parseFlags(['--nope'])).toThrow(/unknown flag/);
  });
});

describe('cli.sync run()', () => {
  const egov = (outcome: string): RunPortalSyncResult =>
    ({ api: 'egov-bg', result: { summaryOutcome: outcome } }) as unknown as RunPortalSyncResult;
  const ckan = (outcome: string): RunPortalSyncResult =>
    ({ api: 'ckan', result: { summaryOutcome: outcome } }) as unknown as RunPortalSyncResult;

  it('returns 0 on --help and 2 on a parse error', async () => {
    const io = captureIO();
    try {
      expect(await run(['--help'])).toBe(0);
      expect(await run(['--nope'])).toBe(2);
    } finally {
      io.restore();
    }
  });

  it('egov: prints the run record and exits 0 on success, 3 on failure', async () => {
    const cfg = seededConfig();
    const io = captureIO();
    let ok: number;
    let bad: number;
    try {
      ok = await withConfig(cfg, () => run([], { runPortalSync: async () => egov('success') }));
      bad = await withConfig(cfg, () => run([], { runPortalSync: async () => egov('failed') }));
    } finally {
      io.restore();
    }
    expect(ok).toBe(0);
    expect(bad).toBe(3);
    expect(io.out.join('')).toContain('summaryOutcome');
  });

  it('ckan: exits 0 on success and 3 otherwise', async () => {
    const cfg = seededConfig();
    const io = captureIO();
    let ok: number;
    let partial: number;
    try {
      ok = await withConfig(cfg, () => run([], { runPortalSync: async () => ckan('success') }));
      partial = await withConfig(cfg, () =>
        run([], { runPortalSync: async () => ckan('partial') }),
      );
    } finally {
      io.restore();
    }
    expect(ok).toBe(0);
    expect(partial).toBe(3);
  });

  it('returns 5 on lock contention and 4 on any other error', async () => {
    const cfg = seededConfig();
    const io = captureIO();
    let locked: number;
    let errored: number;
    try {
      locked = await withConfig(cfg, () =>
        run([], {
          runPortalSync: async () => {
            throw new LockContentionError('another run holds the lock');
          },
        }),
      );
      errored = await withConfig(cfg, () =>
        run([], {
          runPortalSync: async () => {
            throw new Error('boom');
          },
        }),
      );
    } finally {
      io.restore();
    }
    expect(locked).toBe(5);
    expect(errored).toBe(4);
    expect(io.err.join('')).toContain('sync rejected');
    expect(io.err.join('')).toContain('boom');
  });
});
