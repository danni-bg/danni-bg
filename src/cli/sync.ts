import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../config/loader.ts';
import { type ScopeConfig, ScopeConfigSchema } from '../config/schema.ts';
import { buildPortalHttp, runPortalSync } from '../crawler/portal-sync.ts';
import { LockContentionError } from '../manifest/sync-run.ts';
import { createNotifier } from '../notify/notifier.ts';
import { openDb } from '../store/db.ts';

export interface SyncFlags {
  scope?: ScopeConfig | undefined;
  manifestOut?: string | undefined;
  dryRun?: boolean | undefined;
  max?: number | undefined;
  retryFailed?: boolean | undefined;
}

export function parseScopeArg(
  arg: string | undefined,
  cwd = process.cwd(),
): ScopeConfig | undefined {
  if (!arg) return undefined;
  let raw: string;
  if (arg.startsWith('@')) {
    raw = readFileSync(resolve(cwd, arg.slice(1)), 'utf-8');
  } else {
    raw = arg;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `--scope is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const result = ScopeConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `--scope failed validation: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  return result.data;
}

export function parseFlags(args: string[]): SyncFlags {
  const flags: SyncFlags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--once') {
      // accepted for compatibility; trigger=manual is implicit
    } else if (a === '--dry-run') {
      flags.dryRun = true;
    } else if (a === '--retry-failed') {
      flags.retryFailed = true;
    } else if (a === '--scope') {
      flags.scope = parseScopeArg(args[i + 1]);
      i++;
    } else if (a === '--max') {
      const v = Number(args[i + 1]);
      if (!Number.isInteger(v) || v <= 0) throw new Error('--max requires a positive integer');
      flags.max = v;
      i++;
    } else if (a === '--manifest-out') {
      flags.manifestOut = args[i + 1];
      i++;
    } else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'danni sync [--scope <json|@file>] [--once] [--manifest-out <path>] [--dry-run] [--max <n>] [--retry-failed]\n' +
          '  --max <n>        per-session dataset batch (egov): advances and persists the resume cursor\n' +
          '  --retry-failed   re-attempt recorded failures up to the fixed max-attempts cap (egov)\n',
      );
      throw new Error('__HELP__');
    } else {
      throw new Error(`unknown flag: ${a}`);
    }
  }
  return flags;
}

/** Injectable seam (tests): the heavy/networked sync runner. Defaults to the real implementation. */
export interface SyncRunDeps {
  runPortalSync?: typeof runPortalSync;
}

export async function run(args: string[], deps: SyncRunDeps = {}): Promise<number> {
  const runPortalSyncFn = deps.runPortalSync ?? runPortalSync;
  let flags: SyncFlags;
  try {
    flags = parseFlags(args);
  } catch (err) {
    if (err instanceof Error && err.message === '__HELP__') return 0;
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  const config = loadConfig();
  const storeRoot = resolve(process.cwd(), config.store.root);

  const db = openDb({ storeRoot, loadVec: false });
  try {
    // Both the egov-bg and CKAN paths share one HTTP stack + sync runner via runPortalSync, so the
    // interactive and scheduled entry points stay in lockstep (FR-007: single lock, one dispatch).
    const http = buildPortalHttp(config);
    const notifier = createNotifier({ config: config.schedule.notifier });

    try {
      const sync = await runPortalSyncFn({
        db,
        config,
        http,
        storeRoot,
        trigger: 'manual',
        notifier,
        scope: flags.scope,
        ...(flags.max !== undefined ? { max: flags.max } : {}),
        ...(flags.retryFailed !== undefined ? { retryFailed: flags.retryFailed } : {}),
        ...(flags.dryRun ? { dryRun: true } : {}),
        ...(flags.manifestOut ? { manifestOut: flags.manifestOut } : {}),
      });
      // The egov path emits its (resumable) run record to stdout; `completed:false` means more
      // sessions remain. Exit code semantics are preserved per path.
      if (sync.api === 'egov-bg') {
        process.stdout.write(`${JSON.stringify(sync.result)}\n`);
        return sync.result.summaryOutcome === 'failed' ? 3 : 0;
      }
      return sync.result.summaryOutcome === 'success' ? 0 : 3;
    } catch (err) {
      if (err instanceof LockContentionError) {
        process.stderr.write(`sync rejected: ${err.message}\n`);
        return 5;
      }
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      return 4;
    }
  } finally {
    db.close();
  }
}
