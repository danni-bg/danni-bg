import { describe, expect, it } from 'bun:test';
import { run } from './pipeline.ts';

const stage = (code: number, calls: string[], name: string) => async (_a: string[]) => {
  calls.push(name);
  return code;
};

describe('danni pipeline (spec 068)', () => {
  it('runs sync → curate → index in order and returns 0 when all succeed', async () => {
    const calls: string[] = [];
    const code = await run([], {
      runSync: stage(0, calls, 'sync'),
      runCurate: stage(0, calls, 'curate'),
      runIndex: stage(0, calls, 'index'),
    });
    expect(code).toBe(0);
    expect(calls).toEqual(['sync', 'curate', 'index']);
  });

  it('stops at the first failing stage and returns its code (sync fails → curate/index skipped)', async () => {
    const calls: string[] = [];
    const code = await run([], {
      runSync: stage(4, calls, 'sync'),
      runCurate: stage(0, calls, 'curate'),
      runIndex: stage(0, calls, 'index'),
    });
    expect(code).toBe(4);
    expect(calls).toEqual(['sync']);
  });

  it('skips index when curate fails', async () => {
    const calls: string[] = [];
    const code = await run([], {
      runSync: stage(0, calls, 'sync'),
      runCurate: stage(3, calls, 'curate'),
      runIndex: stage(0, calls, 'index'),
    });
    expect(code).toBe(3);
    expect(calls).toEqual(['sync', 'curate']);
  });
});
