import { describe, expect, it } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFlags, run } from '../../../src/cli/status.ts';
import { CrawlCheckpointsRepo } from '../../../src/store/repos/crawl-checkpoints.ts';
import { SyncRunsRepo } from '../../../src/store/repos/sync-runs.ts';
import {
  baseConfig,
  captureIO,
  tmpStore,
  withConfig,
  withMigratedStore,
  writeConfig,
} from './_cli-fixture.ts';

/** Seed a store with one finished (success) run, one in-progress run, and an active campaign. */
function seededStore(withRobots = false): string {
  const storeRoot = tmpStore();
  withMigratedStore(storeRoot, (db) => {
    const runs = new SyncRunsRepo(db);
    runs.create({ id: 'run-done', trigger: 'manual', scopeFilterJson: '{}' });
    runs.finalize({
      id: 'run-done',
      summaryOutcome: 'success',
      totals: {
        discovered: 3,
        captured: 3,
        skippedUnchanged: 0,
        failed: 0,
        withdrawn: 0,
        outOfScope: 0,
      },
      manifestPath: null,
    });
    runs.create({ id: 'run-live', trigger: 'scheduled', scopeFilterJson: '{}' });
    new CrawlCheckpointsRepo(db).createCampaign({
      scopeHash: 'abcdef0123456789',
      scopeJson: { all: true },
      frozenIds: ['ds-1'],
    });
  });
  if (withRobots) writeFileSync(join(storeRoot, 'robots-cache.json'), '{}');
  return writeConfig(baseConfig(storeRoot));
}

describe('cli.status parseFlags', () => {
  it('parses --json and a valid --limit', () => {
    expect(parseFlags(['--json']).json).toBe(true);
    expect(parseFlags(['--limit', '5']).limit).toBe(5);
  });
  it('rejects an out-of-range --limit', () => {
    expect(() => parseFlags(['--limit', '999'])).toThrow(/--limit/);
  });
  it('throws __HELP__ on --help and rejects unknown flags', () => {
    expect(() => parseFlags(['--help'])).toThrow('__HELP__');
    expect(() => parseFlags(['--nope'])).toThrow(/unknown flag/);
  });
});

describe('cli.status run()', () => {
  it('returns 0 on --help and 2 on a parse error', async () => {
    const io = captureIO();
    try {
      expect(await run(['--help'])).toBe(0);
      expect(await run(['--nope'])).toBe(2);
    } finally {
      io.restore();
    }
  });

  it('returns 4 when there is no store', async () => {
    const cfg = writeConfig(baseConfig(tmpStore()));
    const io = captureIO();
    try {
      expect(await withConfig(cfg, () => run([]))).toBe(4);
    } finally {
      io.restore();
    }
    expect(io.err.join('')).toContain('no danni.sqlite');
  });

  it('emits a JSON report with runs and campaigns', async () => {
    const cfg = seededStore();
    const io = captureIO();
    try {
      expect(await withConfig(cfg, () => run(['--json']))).toBe(0);
    } finally {
      io.restore();
    }
    const report = JSON.parse(io.out.join('')) as {
      runs: unknown[];
      crawlCampaigns: unknown[];
    };
    expect(report.runs.length).toBe(2);
    expect(report.crawlCampaigns.length).toBe(1);
  });

  it('prints the human report incl. campaigns + robots cache age', async () => {
    const cfg = seededStore(true);
    const io = captureIO();
    try {
      expect(await withConfig(cfg, () => run(['--limit', '5']))).toBe(0);
    } finally {
      io.restore();
    }
    const out = io.out.join('');
    expect(out).toContain('recentRuns:');
    expect(out).toContain('run-done');
    expect(out).toContain('(in-progress)');
    expect(out).toContain('crawlCampaigns:');
    expect(out).toContain('robotsCacheAgeSeconds:');
  });
});
