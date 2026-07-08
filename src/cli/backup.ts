import { Database } from 'bun:sqlite';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadConfig } from '../config/loader.ts';
import { ensureDir } from '../lib/fs.ts';
import { loadVecExtension, openDb } from '../store/db.ts';

export interface BackupResult {
  /** Absolute path of the snapshot that was written. */
  dest: string;
  /** Size of the snapshot on disk, in bytes. */
  bytes: number;
  /** Result of `PRAGMA integrity_check` on the snapshot (`ok` when healthy). */
  integrity: string;
  /** Number of objects (tables/indexes/…) in the snapshot — a cheap "it's really a DB" probe. */
  objectCount: number;
}

/**
 * Produce a consistent, verified snapshot of the live store (spec 043 FR-252) without stopping the
 * server. `VACUUM INTO` reads the live WAL-mode database under SQLite's online-backup semantics —
 * concurrent writers are safe — and writes a single defragmented file. We checkpoint the WAL first
 * so the snapshot reflects the latest committed state, then re-open the output and run
 * `PRAGMA integrity_check` + an object-count probe before reporting success.
 *
 * Restore is a file swap (mirror + all SaaS state live in this one file) — see docs/backup-restore.md.
 *
 * `loadVec` (default `false`) registers the sqlite-vec module. Since spec 050 (FR-322) similarity runs
 * over the cached embedding matrix and the schema provisions NO `vec0` virtual table, so `VACUUM` needs
 * no module and a backup works on a clean checkout without the (operator-supplied) binary. The flag
 * stays as the opt-in seam: an operator who has provisioned `vec0` tables passes `true` so `VACUUM`
 * can rebuild them (matches `openDb`'s `loadVec` default and every other store caller).
 */
export function backup(storeRoot: string, dest: string, loadVec = false): BackupResult {
  const src = join(storeRoot, 'danni.sqlite');
  if (!existsSync(src)) {
    throw new Error(`no danni.sqlite at ${storeRoot}. Run 'bun run db:migrate' first.`);
  }
  const target = resolve(process.cwd(), dest);
  // VACUUM INTO refuses to overwrite; surface that as a clear operator error rather than an opaque one.
  if (existsSync(target)) {
    throw new Error(`backup target already exists: ${target}. Remove it or choose another path.`);
  }
  ensureDir(dirname(target));

  const db = openDb({ storeRoot, loadVec });
  try {
    // Fold the WAL back into the main DB so the snapshot captures the latest committed writes.
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}';`);
  } finally {
    db.close();
  }

  // Verify the output opens, is structurally sound, and holds objects before we call it a backup.
  const copy = new Database(target, { readonly: true });
  if (loadVec) loadVecExtension(copy);
  let integrity: string;
  let objectCount: number;
  try {
    integrity =
      copy.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get()
        ?.integrity_check ?? 'unknown';
    objectCount =
      copy.query<{ n: number }, []>('SELECT count(*) AS n FROM sqlite_master').get()?.n ?? 0;
  } finally {
    copy.close();
  }
  if (integrity !== 'ok') {
    throw new Error(`backup verification failed: integrity_check returned "${integrity}"`);
  }

  return { dest: target, bytes: statSync(target).size, integrity, objectCount };
}

interface BackupFlags {
  json?: boolean;
}

export function parseFlags(args: string[]): { dest: string; flags: BackupFlags } {
  let dest: string | undefined;
  const flags: BackupFlags = {};
  for (const a of args) {
    if (a === '--json') flags.json = true;
    else if (a === '--help' || a === '-h') {
      process.stdout.write('danni backup <dest> [--json]\n');
      throw new Error('__HELP__');
    } else if (!a.startsWith('--')) {
      dest = a;
    } else {
      throw new Error(`unknown flag: ${a}`);
    }
  }
  if (!dest)
    throw new Error('missing <dest> (path for the snapshot, e.g. backups/danni-2026-07-07.sqlite)');
  return { dest, flags };
}

export async function run(args: string[]): Promise<number> {
  let dest: string;
  let flags: BackupFlags;
  try {
    const parsed = parseFlags(args);
    dest = parsed.dest;
    flags = parsed.flags;
  } catch (err) {
    if (err instanceof Error && err.message === '__HELP__') return 0;
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  const config = loadConfig();
  const storeRoot = resolve(process.cwd(), config.store.root);
  const result = backup(storeRoot, dest);
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`backup written: ${result.dest}\n`);
    process.stdout.write(`bytes: ${result.bytes}\n`);
    process.stdout.write(`integrity_check: ${result.integrity}\n`);
    process.stdout.write(`objects: ${result.objectCount}\n`);
  }
  return 0;
}
