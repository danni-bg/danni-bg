// `danni pipeline` (spec 068) — a ONE-SHOT full refresh: sync → curate → index, in order, stopping at
// the first failing stage. Built for a scheduled k8s CronJob (one process, one exit code) rather than
// the long-running in-process scheduler (`danni schedule`, which only runs the sync stage): the CronJob
// invokes this, and its non-zero exit is the job-failure signal the cluster alerts on. Each stage still
// opens/closes its own store + loads config exactly as the standalone CLIs do, so behavior is identical
// to running the three commands by hand — this just makes the sequence one atomic, alertable unit.

import { withContext } from '../logging/logger.ts';
import { run as runCurate } from './curate.ts';
import { run as runIndex } from './index-cmd.ts';
import { run as runSync } from './sync.ts';

export interface PipelineDeps {
  runSync?: (args: string[]) => Promise<number>;
  runCurate?: (args: string[]) => Promise<number>;
  runIndex?: (args: string[]) => Promise<number>;
}

/**
 * Run the full refresh. Returns 0 iff every stage succeeded; otherwise the exit code of the first
 * stage that failed (later stages are skipped — a failed sync must not be curated/indexed into a
 * half-updated mirror). Stages run with no args = a full run.
 */
export async function run(_args: string[], deps: PipelineDeps = {}): Promise<number> {
  const stages: { name: string; fn: (a: string[]) => Promise<number> }[] = [
    { name: 'sync', fn: deps.runSync ?? runSync },
    { name: 'curate', fn: deps.runCurate ?? runCurate },
    { name: 'index', fn: deps.runIndex ?? runIndex },
  ];
  const log = withContext({ component: 'pipeline' });

  for (const stage of stages) {
    log.info('pipeline.stage_start', { stage: stage.name });
    const code = await stage.fn([]);
    if (code !== 0) {
      log.error('pipeline.stage_failed', { stage: stage.name, code });
      return code;
    }
    log.info('pipeline.stage_done', { stage: stage.name });
  }
  log.info('pipeline.completed', {});
  return 0;
}
