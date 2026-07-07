import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_BUSY_TIMEOUT_MS, openDb } from './db.ts';

// A tiny second-writer process: opens the same file, holds a write lock (BEGIN IMMEDIATE + INSERT)
// for `holdMs`, then commits. Stands in for `danni sync/curate/index` writing while the server does.
const HOLDER = `import { Database } from 'bun:sqlite';
const [dbPath, holdMs] = process.argv.slice(2);
const db = new Database(dbPath, { create: true, readwrite: true });
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 5000;');
db.exec('BEGIN IMMEDIATE;');
db.query('INSERT INTO lock_probe (v) VALUES (?)').run('holder');
process.stdout.write('LOCKED\\n');
Bun.sleepSync(Number(holdMs));
db.exec('COMMIT;');
db.close();
`;

async function waitForMarker(stream: ReadableStream<Uint8Array>, marker: string): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (!buf.includes(marker)) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`child exited before emitting "${marker}"`);
      buf += decoder.decode(value);
    }
  } finally {
    reader.releaseLock();
  }
}

describe('openDb concurrency safety (spec 043)', () => {
  let dir: string;
  let holderPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'danni-db-'));
    holderPath = join(dir, 'holder.ts');
    writeFileSync(holderPath, HOLDER);
    // Seed the file + table in WAL mode so both connections agree on the journal.
    const db = openDb({ storeRoot: dir, loadVec: false });
    db.exec('CREATE TABLE lock_probe (id INTEGER PRIMARY KEY, v TEXT);');
    db.close();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('FR-250: sets busy_timeout on every opened connection', () => {
    const db = openDb({ storeRoot: dir, loadVec: false });
    try {
      const row = db.query<{ timeout: number }, []>('PRAGMA busy_timeout').get();
      expect(row?.timeout).toBe(DEFAULT_BUSY_TIMEOUT_MS);
    } finally {
      db.close();
    }
  });

  it('FR-251/SC-1: a second writer queues past a held lock and succeeds (no SQLITE_BUSY)', async () => {
    const dbPath = join(dir, 'danni.sqlite');
    const holdMs = 600;
    const proc = Bun.spawn(['bun', 'run', holderPath, dbPath, String(holdMs)], { stdout: 'pipe' });
    await waitForMarker(proc.stdout, 'LOCKED');

    const db = openDb({ storeRoot: dir, loadVec: false });
    try {
      const start = Date.now();
      // With a held write lock this would throw SQLITE_BUSY immediately at busy_timeout=0; instead
      // it queues until the holder commits, then succeeds.
      db.query('INSERT INTO lock_probe (v) VALUES (?)').run('server');
      const waited = Date.now() - start;
      expect(waited).toBeGreaterThan(200); // it genuinely waited for the lock, didn't error out
      const count = db.query<{ n: number }, []>('SELECT count(*) AS n FROM lock_probe').get();
      expect(count?.n).toBe(2); // both the holder's row and ours committed
    } finally {
      db.close();
    }
    await proc.exited;
  });

  it('FR-250: with busy_timeout=0 the same contention throws immediately (regression guard)', async () => {
    const dbPath = join(dir, 'danni.sqlite');
    const proc = Bun.spawn(['bun', 'run', holderPath, dbPath, '800'], { stdout: 'pipe' });
    await waitForMarker(proc.stdout, 'LOCKED');

    const db = openDb({ storeRoot: dir, loadVec: false, busyTimeoutMs: 0 });
    try {
      expect(() => db.query('INSERT INTO lock_probe (v) VALUES (?)').run('server')).toThrow();
    } finally {
      db.close();
    }
    await proc.exited;
  });
});
