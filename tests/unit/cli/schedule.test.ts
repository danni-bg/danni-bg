import { describe, expect, it } from 'bun:test';
import type { ScheduleRunDeps } from '../../../src/cli/schedule.ts';
import { run } from '../../../src/cli/schedule.ts';
import { LockContentionError } from '../../../src/manifest/sync-run.ts';
import type { SchedulerOptions } from '../../../src/schedule/scheduler.ts';
import {
  baseConfig,
  captureIO,
  tmpStore,
  withConfig,
  withMigratedStore,
  writeConfig,
} from './_cli-fixture.ts';

function config(schedule: Record<string, unknown>): string {
  const storeRoot = tmpStore();
  withMigratedStore(storeRoot, () => {});
  const raw = baseConfig(storeRoot);
  raw.schedule = {
    onOverlap: 'skip',
    failureRateThreshold: 0.05,
    notifier: { kind: 'stderr' },
    ...schedule,
  };
  return writeConfig(raw);
}

/** A makeScheduler whose start() runs a caller-provided scenario against the captured options. */
function fakeScheduler(
  scenario: (opts: SchedulerOptions) => Promise<void>,
): NonNullable<ScheduleRunDeps['makeScheduler']> {
  return (opts: SchedulerOptions) => ({ start: () => scenario(opts) });
}

describe('cli.schedule run() dispatch', () => {
  it('prints usage and returns 2 with no subcommand', async () => {
    const io = captureIO();
    try {
      expect(await run([])).toBe(2);
    } finally {
      io.restore();
    }
    expect(io.err.join('')).toContain('{install|disable|show}');
  });

  it('show: reports disabled when schedule is off', async () => {
    const cfg = config({ enabled: false, cron: null });
    const io = captureIO();
    try {
      expect(await withConfig(cfg, () => run(['show']))).toBe(0);
    } finally {
      io.restore();
    }
    expect(io.out.join('')).toContain('schedule: disabled');
  });

  it('show: reports the next fire when enabled', async () => {
    const cfg = config({ enabled: true, cron: '0 3 * * *' });
    const io = captureIO();
    try {
      expect(await withConfig(cfg, () => run(['show']))).toBe(0);
    } finally {
      io.restore();
    }
    expect(io.out.join('')).toContain('schedule: enabled');
  });

  it('disable: instructs the operator and returns 2', async () => {
    const cfg = config({ enabled: true, cron: '0 3 * * *' });
    const io = captureIO();
    try {
      expect(await withConfig(cfg, () => run(['disable']))).toBe(2);
    } finally {
      io.restore();
    }
    expect(io.err.join('')).toContain('edit danni.config.json');
  });

  it('rejects an unknown subcommand', async () => {
    const cfg = config({ enabled: true, cron: '0 3 * * *' });
    const io = captureIO();
    try {
      expect(await withConfig(cfg, () => run(['frobnicate']))).toBe(2);
    } finally {
      io.restore();
    }
    expect(io.err.join('')).toContain('unknown subcommand');
  });

  it('install: refuses when schedule is disabled', async () => {
    const cfg = config({ enabled: false, cron: null });
    const io = captureIO();
    try {
      expect(await withConfig(cfg, () => run(['install']))).toBe(2);
    } finally {
      io.restore();
    }
    expect(io.err.join('')).toContain('schedule.enabled is false');
  });
});

describe('cli.schedule run() install', () => {
  const installCfg = () => config({ enabled: true, cron: '0 3 * * *' });

  it('fires a successful sync and returns 0', async () => {
    const cfg = installCfg();
    let fired = false;
    const io = captureIO();
    let code: number;
    try {
      code = await withConfig(cfg, () =>
        run(['install'], {
          runPortalSync: async () => {
            fired = true;
            return { api: 'egov-bg', result: {} } as never;
          },
          makeScheduler: fakeScheduler((opts) => opts.fire()),
        }),
      );
    } finally {
      io.restore();
    }
    expect(code).toBe(0);
    expect(fired).toBe(true);
  });

  it('a fire hitting lock contention sets exit 5', async () => {
    const cfg = installCfg();
    const io = captureIO();
    let code: number;
    try {
      code = await withConfig(cfg, () =>
        run(['install'], {
          runPortalSync: async () => {
            throw new LockContentionError('run-1');
          },
          makeScheduler: fakeScheduler((opts) => opts.fire()),
        }),
      );
    } finally {
      io.restore();
    }
    expect(code).toBe(5);
  });

  it('a fire hitting a generic error is rethrown to the scheduler', async () => {
    const cfg = installCfg();
    let caught = false;
    const io = captureIO();
    let code: number;
    try {
      code = await withConfig(cfg, () =>
        run(['install'], {
          runPortalSync: async () => {
            throw new Error('kaboom');
          },
          makeScheduler: fakeScheduler(async (opts) => {
            await opts.fire().catch(() => {
              caught = true;
            });
          }),
        }),
      );
    } finally {
      io.restore();
    }
    expect(caught).toBe(true);
    expect(code).toBe(0);
  });

  it('uses the real Scheduler by default and returns when the signal is already aborted', async () => {
    const cfg = installCfg();
    const ac = new AbortController();
    ac.abort();
    const io = captureIO();
    let code: number;
    try {
      code = await withConfig(cfg, () =>
        run(['install'], {
          runPortalSync: async () => ({ api: 'egov-bg', result: {} }) as never,
          signal: ac.signal,
        }),
      );
    } finally {
      io.restore();
    }
    expect(code).toBe(0);
  });

  it('an overlap skip (onLockSkip) sets exit 5', async () => {
    const cfg = installCfg();
    const io = captureIO();
    let code: number;
    try {
      code = await withConfig(cfg, () =>
        run(['install'], {
          runPortalSync: async () => ({ api: 'egov-bg', result: {} }) as never,
          makeScheduler: fakeScheduler(async (opts) => {
            opts.onLockSkip?.();
          }),
        }),
      );
    } finally {
      io.restore();
    }
    expect(code).toBe(5);
  });
});
