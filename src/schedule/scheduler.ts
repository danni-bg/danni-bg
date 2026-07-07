import { withContext } from '../logging/logger.ts';
import { nextFire, parseCron } from './cron.ts';

export interface SchedulerOptions {
  cron: string;
  // Only `'skip'` overlap handling exists (spec 056 FR-389): if a fire is still running when the next
  // one is due, the new fire is skipped. Real queueing is a future spec.
  onOverlap: 'skip';
  fire: () => Promise<void>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  onLockSkip?: () => void;
  maxFires?: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class Scheduler {
  private readonly cronExpr: string;
  private readonly fire: () => Promise<void>;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxFires: number;
  private readonly onLockSkip: () => void;
  private running = false;

  constructor(opts: SchedulerOptions) {
    this.cronExpr = opts.cron;
    this.fire = opts.fire;
    this.now = opts.now ?? (() => new Date());
    this.sleep = opts.sleep ?? defaultSleep;
    this.maxFires = opts.maxFires ?? Number.POSITIVE_INFINITY;
    this.onLockSkip = opts.onLockSkip ?? (() => {});
  }

  nextFireAfter(d: Date): Date {
    return nextFire(parseCron(this.cronExpr), d);
  }

  async start(signal?: AbortSignal): Promise<void> {
    const log = withContext({ component: 'scheduler' });
    let fired = 0;
    while (fired < this.maxFires && !signal?.aborted) {
      const next = this.nextFireAfter(this.now());
      const wait = next.getTime() - this.now().getTime();
      if (wait > 0) await this.sleep(wait);
      if (signal?.aborted) break;
      // Overlap handling is skip-only (spec 056 FR-389): if a fire is still running when the next is
      // due, skip this tick rather than queue it.
      if (this.running) {
        this.onLockSkip();
        log.warn('scheduler.overlap_skip', { nextFireAt: next.toISOString() });
        fired++;
        continue;
      }
      this.running = true;
      try {
        await this.fire();
      } catch (err) {
        log.error('scheduler.fire_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        this.running = false;
      }
      fired++;
    }
  }
}
