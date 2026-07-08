import { describe, expect, it } from 'bun:test';
import { BackoffRunner, parseRetryAfter } from '../../../src/crawler/backoff.ts';
import { RetryExhausted } from '../../../src/lib/errors.ts';

describe('crawler.BackoffRunner', () => {
  it('rejects bad config', () => {
    expect(() => new BackoffRunner({ initialMs: 0, maxMs: 1000, failureBudget: 1 })).toThrow();
    expect(() => new BackoffRunner({ initialMs: 100, maxMs: 50, failureBudget: 1 })).toThrow();
    expect(() => new BackoffRunner({ initialMs: 100, maxMs: 1000, failureBudget: 0 })).toThrow();
  });

  it('returns the value on first success', async () => {
    const runner = new BackoffRunner({ initialMs: 1, maxMs: 1, failureBudget: 3 });
    const result = await runner.run('t', async () => ({ ok: true, value: 42 }));
    expect(result).toBe(42);
  });

  it('retries failures up to the budget then throws', async () => {
    const sleeps: number[] = [];
    const runner = new BackoffRunner({
      initialMs: 100,
      maxMs: 1000,
      failureBudget: 3,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0.5,
    });
    let calls = 0;
    await expect(
      runner.run('t', async () => {
        calls++;
        return { ok: false, error: new Error('boom') };
      }),
    ).rejects.toBeInstanceOf(RetryExhausted);
    expect(calls).toBe(3);
    expect(sleeps).toHaveLength(2);
  });

  it('caps the exponential delay at maxMs', () => {
    const runner = new BackoffRunner({
      initialMs: 100,
      maxMs: 150,
      failureBudget: 10,
      random: () => 1,
    });
    // attempt 5 → 100 * 2**5 = 3200, capped to maxMs=150; random()=1 keeps the full jittered value.
    expect(runner.delayMs(5)).toBe(150);
    // attempt 0 → below the cap, returned as-is.
    expect(runner.delayMs(0)).toBe(100);
  });

  it('uses the real default sleep when none is injected', async () => {
    // No `sleep` override: the one retry drives the built-in setTimeout-based defaultSleep.
    const runner = new BackoffRunner({
      initialMs: 1,
      maxMs: 1,
      failureBudget: 2,
      random: () => 0,
    });
    let calls = 0;
    await expect(
      runner.run('t', async () => {
        calls++;
        return { ok: false, error: new Error('boom') };
      }),
    ).rejects.toBeInstanceOf(RetryExhausted);
    expect(calls).toBe(2);
  });

  it('honors retryAfterMs from outcome', async () => {
    const sleeps: number[] = [];
    const runner = new BackoffRunner({
      initialMs: 100,
      maxMs: 1000,
      failureBudget: 2,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    let i = 0;
    const result = await runner.run('t', async () => {
      i++;
      if (i === 1) return { ok: false, error: new Error('429'), retryAfterMs: 1234 };
      return { ok: true, value: 'ok' };
    });
    expect(result).toBe('ok');
    expect(sleeps).toEqual([1234]);
  });
});

describe('crawler.parseRetryAfter', () => {
  it('returns undefined for null/empty', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('   ')).toBeUndefined();
  });

  it('parses a delta-seconds integer', () => {
    expect(parseRetryAfter('5')).toBe(5000);
    expect(parseRetryAfter('0')).toBe(0);
  });

  it('parses an HTTP-date and returns the delta', () => {
    const now = 1_700_000_000_000;
    const future = new Date(now + 60_000).toUTCString();
    const out = parseRetryAfter(future, now);
    expect(out).toBeGreaterThanOrEqual(58000);
    expect(out).toBeLessThanOrEqual(62000);
  });

  it('returns undefined for garbage', () => {
    expect(parseRetryAfter('not-a-number-or-date')).toBeUndefined();
  });
});
