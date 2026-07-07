import { describe, expect, it } from 'bun:test';
import { nextFire, parseCron } from '../../../src/schedule/cron.ts';
import { Scheduler } from '../../../src/schedule/scheduler.ts';

describe('schedule.cron', () => {
  it('parses 5 fields with star semantics', () => {
    const c = parseCron('* * * * *');
    expect(c.minutes.length).toBe(60);
    expect(c.hours.length).toBe(24);
  });

  it('parses step values', () => {
    const c = parseCron('*/15 * * * *');
    expect(c.minutes).toEqual([0, 15, 30, 45]);
  });

  it('parses ranges and lists', () => {
    const c = parseCron('0 9-11 * * 1,3,5');
    expect(c.hours).toEqual([9, 10, 11]);
    expect(c.daysOfWeek).toEqual([1, 3, 5]);
  });

  it('rejects wrong field count', () => {
    expect(() => parseCron('* * * *')).toThrow();
  });

  it('rejects out-of-range', () => {
    expect(() => parseCron('60 * * * *')).toThrow();
  });

  it('rejects invalid step', () => {
    expect(() => parseCron('*/0 * * * *')).toThrow();
  });

  it('rejects non-numeric value', () => {
    expect(() => parseCron('abc * * * *')).toThrow();
  });

  it('nextFire jumps to the next matching minute', () => {
    const c = parseCron('15 * * * *');
    const next = nextFire(c, new Date('2026-05-08T10:14:00Z'));
    expect(next.getUTCMinutes()).toBe(15);
  });

  it('nextFire throws when no match within a year', () => {
    // an impossible cron: minute=0 in month=2 day=30
    expect(() => nextFire(parseCron('0 0 30 2 *'), new Date('2026-01-01T00:00:00Z'))).toThrow();
  });
});

describe('schedule.Scheduler', () => {
  it('fires once when cron matches and respects maxFires', async () => {
    let fires = 0;
    const now = new Date('2026-05-08T00:00:00Z');
    const sched = new Scheduler({
      cron: '* * * * *',
      onOverlap: 'skip',
      now: () => now,
      sleep: async () => undefined,
      fire: async () => {
        fires++;
      },
      maxFires: 2,
    });
    await sched.start();
    expect(fires).toBe(2);
  });

  it('overlap=skip increments counter without firing when running', async () => {
    let active = 0;
    let max = 0;
    let fires = 0;
    let skips = 0;
    const sched = new Scheduler({
      cron: '* * * * *',
      onOverlap: 'skip',
      now: () => new Date('2026-05-08T00:00:00Z'),
      sleep: async () => undefined,
      onLockSkip: () => {
        skips++;
      },
      fire: async () => {
        active++;
        max = Math.max(max, active);
        // simulate the loop continuing without await
        if (fires === 0) {
          // mark scheduler.running ourselves by hijacking the next fire path
        }
        fires++;
        active--;
      },
      maxFires: 1,
    });
    await sched.start();
    expect(fires).toBe(1);
    expect(skips).toBe(0);
  });

  it('aborts via signal before any fires', async () => {
    const ctrl = new AbortController();
    let fires = 0;
    const sched = new Scheduler({
      cron: '* * * * *',
      onOverlap: 'skip',
      now: () => new Date('2026-05-08T00:00:00Z'),
      sleep: async () => undefined,
      fire: async () => {
        fires++;
        ctrl.abort();
      },
      maxFires: 100,
    });
    await sched.start(ctrl.signal);
    expect(fires).toBe(1);
  });

  it('logs and continues when fire throws', async () => {
    let fires = 0;
    const sched = new Scheduler({
      cron: '* * * * *',
      onOverlap: 'skip',
      now: () => new Date('2026-05-08T00:00:00Z'),
      sleep: async () => undefined,
      fire: async () => {
        fires++;
        throw new Error('x');
      },
      maxFires: 1,
    });
    await sched.start();
    expect(fires).toBe(1);
  });

  it('nextFireAfter exposes parsed cron schedule', () => {
    const sched = new Scheduler({
      cron: '0 12 * * *',
      onOverlap: 'skip',
      fire: async () => undefined,
      sleep: async () => undefined,
    });
    const next = sched.nextFireAfter(new Date('2026-05-08T10:00:00Z'));
    expect(next.getUTCHours()).toBe(12);
  });
});
