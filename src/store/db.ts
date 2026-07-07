import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDir } from '../lib/fs.ts';

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));

function platformDir(): string {
  const arch = process.arch;
  const platform = process.platform;
  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64';
  if (platform === 'darwin' && arch === 'arm64') return 'macos-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'macos-x64';
  throw new Error(`Unsupported platform/arch for sqlite-vec: ${platform}/${arch}`);
}

function vecExtensionPath(): string {
  const dir = platformDir();
  const ext = process.platform === 'darwin' ? 'dylib' : 'so';
  return join(PROJECT_ROOT, 'vendor', 'sqlite-vec', dir, `vec0.${ext}`);
}

/** Default SQLITE_BUSY wait before a blocked writer gives up (spec 043 FR-250). */
export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

export interface OpenDbOptions {
  storeRoot: string;
  /**
   * Load the `sqlite-vec` extension (default `false`, spec 050 FR-322). Similarity search runs as
   * in-process cosine over the cached embedding matrix (`src/index/vector-cache.ts`), so no caller
   * needs `vec0` — and the vendored binary is absent on a clean checkout. Left as an opt-in seam for
   * an operator who has provisioned the extension; requesting it without the binary still throws.
   */
  loadVec?: boolean;
  fileName?: string;
  /** ms a blocked writer queues before erroring (default {@link DEFAULT_BUSY_TIMEOUT_MS}). */
  busyTimeoutMs?: number;
}

/** Load the sqlite-vec extension onto an already-open connection (also needed by `VACUUM`/reads of
 *  vec0 virtual tables on secondary connections). Throws if the vendored binary is missing. */
export function loadVecExtension(db: Database): void {
  const extPath = vecExtensionPath();
  if (!existsSync(extPath)) {
    throw new Error(
      `sqlite-vec extension not found at ${extPath}. See vendor/sqlite-vec/README.md for operator setup.`,
    );
  }
  db.loadExtension(extPath);
}

export function openDb(options: OpenDbOptions): Database {
  ensureDir(options.storeRoot);
  const path = join(options.storeRoot, options.fileName ?? 'danni.sqlite');
  const db = new Database(path, { create: true, readwrite: true });
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');
  // WAL permits a single writer; `danni sync/curate/index` and the serving layer are now both
  // writers on this file. Without a busy_timeout a writer that hits the other's lock throws
  // SQLITE_BUSY immediately (a 500-generator). Queue for the timeout instead (spec 043 FR-250).
  db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS};`);

  if (options.loadVec ?? false) loadVecExtension(db);

  return db;
}

export function withTransaction<T>(db: Database, fn: () => T): T {
  const tx = db.transaction(() => fn());
  return tx();
}

export function vecVersion(db: Database): string {
  const row = db.query<{ v: string }, []>('SELECT vec_version() AS v').get();
  if (!row) throw new Error('vec_version() returned no rows');
  return row.v;
}
