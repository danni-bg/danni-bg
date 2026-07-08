import { describe, expect, it } from 'bun:test';
import { run } from '../../../src/cli/refresh-metadata.ts';
import {
  baseConfig,
  captureIO,
  tmpStore,
  withConfig,
  withMigratedStore,
  writeConfig,
} from './_cli-fixture.ts';

function egovConfig(): string {
  const storeRoot = tmpStore();
  withMigratedStore(storeRoot, () => {});
  const raw = baseConfig(storeRoot);
  raw.portal = { api: 'egov-bg', baseUrl: 'https://data.egov.bg/api/3/action/' };
  return writeConfig(raw);
}

function ckanConfig(): string {
  const storeRoot = tmpStore();
  withMigratedStore(storeRoot, () => {});
  return writeConfig(baseConfig(storeRoot));
}

describe('cli.refresh-metadata run()', () => {
  it('prints help and returns 0', async () => {
    const io = captureIO();
    try {
      expect(await run(['--help'])).toBe(0);
    } finally {
      io.restore();
    }
    expect(io.out.join('')).toContain('refresh-metadata');
  });

  it('returns 2 for a non-egov portal', async () => {
    const cfg = ckanConfig();
    const io = captureIO();
    try {
      expect(await withConfig(cfg, () => run([]))).toBe(2);
    } finally {
      io.restore();
    }
    expect(io.err.join('')).toContain('egov-bg portal only');
  });

  it('returns 0 and serializes the result on success', async () => {
    const cfg = egovConfig();
    const io = captureIO();
    let code: number;
    try {
      code = await withConfig(cfg, () =>
        run([], { refreshMetadata: async () => ({ total: 1, refreshed: 1, failed: 0 }) }),
      );
    } finally {
      io.restore();
    }
    expect(code).toBe(0);
    expect(JSON.parse(io.out.join('')).refreshed).toBe(1);
  });

  it('returns 0 when there is nothing to refresh (total 0)', async () => {
    const cfg = egovConfig();
    const io = captureIO();
    try {
      expect(
        await withConfig(cfg, () =>
          run([], { refreshMetadata: async () => ({ total: 0, refreshed: 0, failed: 0 }) }),
        ),
      ).toBe(0);
    } finally {
      io.restore();
    }
  });

  it('returns 4 on total failure (nothing refreshed of many)', async () => {
    const cfg = egovConfig();
    const io = captureIO();
    try {
      expect(
        await withConfig(cfg, () =>
          run([], {
            refreshMetadata: async () => ({ total: 3, refreshed: 0, failed: 3 }),
          }),
        ),
      ).toBe(4);
    } finally {
      io.restore();
    }
  });
});
