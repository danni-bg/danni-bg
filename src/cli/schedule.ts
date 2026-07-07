import { resolve } from 'node:path';
import { loadConfig } from '../config/loader.ts';
import { buildPortalHttp, runPortalSync } from '../crawler/portal-sync.ts';
import { withContext } from '../logging/logger.ts';
import { LockContentionError } from '../manifest/sync-run.ts';
import { createNotifier } from '../notify/notifier.ts';
import { nextFire, parseCron } from '../schedule/cron.ts';
import { Scheduler } from '../schedule/scheduler.ts';
import { openDb } from '../store/db.ts';

export async function run(args: string[]): Promise<number> {
  const sub = args[0];
  if (!sub) {
    process.stderr.write('danni schedule {install|disable|show}\n');
    return 2;
  }
  const config = loadConfig();
  const storeRoot = resolve(process.cwd(), config.store.root);

  if (sub === 'show') {
    if (!config.schedule.enabled || !config.schedule.cron) {
      process.stdout.write('schedule: disabled\n');
      return 0;
    }
    const next = nextFire(parseCron(config.schedule.cron), new Date());
    // Cron fires in server-local time (spec 056 FR-388 removed the `timezone` knob); `next` is an
    // ISO-8601 (UTC) instant.
    process.stdout.write(
      `schedule: enabled cron='${config.schedule.cron}' next=${next.toISOString()} onOverlap=${config.schedule.onOverlap}\n`,
    );
    return 0;
  }
  if (sub === 'disable') {
    process.stderr.write(
      'danni schedule disable: edit danni.config.json and set schedule.enabled=false (operator-driven, by design).\n',
    );
    return 2;
  }
  if (sub !== 'install') {
    process.stderr.write(`unknown subcommand: ${sub}\n`);
    return 2;
  }
  if (!config.schedule.enabled || !config.schedule.cron) {
    process.stderr.write('schedule.enabled is false or schedule.cron is null in config\n');
    return 2;
  }

  const db = openDb({ storeRoot, loadVec: false });
  const log = withContext({ component: 'schedule' });
  try {
    // Dispatch on portal.api like the interactive `sync` CLI (shared runPortalSync) so a scheduled
    // crawl of the live data.egov.bg portal uses the egov-bg adapter + robots opt-out instead of
    // silently issuing CKAN calls that all fail. The HTTP stack persists across fires.
    const http = buildPortalHttp(config);
    const notifier = createNotifier({ config: config.schedule.notifier });

    let exitCode = 0;
    const scheduler = new Scheduler({
      cron: config.schedule.cron,
      onOverlap: config.schedule.onOverlap,
      onLockSkip: () => {
        exitCode = 5;
      },
      fire: async () => {
        try {
          await runPortalSync({
            db,
            config,
            http,
            storeRoot,
            trigger: 'scheduled',
            notifier,
          });
        } catch (err) {
          if (err instanceof LockContentionError) {
            exitCode = 5;
            log.warn('schedule.skipped_overlap', { reason: err.message });
            return;
          }
          throw err;
        }
      },
    });
    log.info('schedule.installed', { cron: config.schedule.cron });
    void args; // reserved for future flags
    await scheduler.start();
    return exitCode;
  } finally {
    db.close();
  }
}
