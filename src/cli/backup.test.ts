import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../store/migrate.ts';
import { UsersRepo } from '../store/repos/users.ts';
import { backup, parseFlags, run } from './backup.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

describe('danni backup parseFlags', () => {
  it('parses the destination and --json', () => {
    expect(parseFlags(['out.sqlite']).dest).toBe('out.sqlite');
    expect(parseFlags(['out.sqlite', '--json']).flags.json).toBe(true);
  });
  it('throws __HELP__ on --help and returns 0 from run()', async () => {
    expect(() => parseFlags(['--help'])).toThrow('__HELP__');
    expect(await run(['--help'])).toBe(0);
  });
  it('throws on a missing destination and on an unknown flag (run() → exit 2)', async () => {
    expect(() => parseFlags([])).toThrow(/missing <dest>/);
    expect(() => parseFlags(['--nope'])).toThrow(/unknown flag/);
    expect(await run([])).toBe(2);
    expect(await run(['--nope'])).toBe(2);
  });
});

describe('danni backup (spec 043 FR-252)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'danni-backup-'));
    const db = new Database(join(dir, 'danni.sqlite'), { create: true, readwrite: true });
    db.exec('PRAGMA journal_mode = WAL;');
    runMigrations(db, join(ROOT, 'migrations'));
    new UsersRepo(db).findOrCreateByKratosId({ kratosIdentityId: 'k1', email: 'a@b.bg' });
    db.close();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes a verified snapshot that opens, passes integrity_check, and holds the data', () => {
    const dest = join(dir, 'snap.sqlite');
    const result = backup(dir, dest, false);

    expect(result.integrity).toBe('ok');
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.objectCount).toBeGreaterThan(0);
    expect(existsSync(dest)).toBe(true);

    const copy = new Database(dest, { readonly: true });
    try {
      expect(copy.query<{ n: number }, []>('SELECT count(*) AS n FROM users').get()?.n).toBe(1);
      // schema_migrations survive, so the restored file passes migration bookkeeping (FR-253).
      const migrations = copy
        .query<{ n: number }, []>('SELECT count(*) AS n FROM schema_migrations')
        .get();
      expect(migrations?.n).toBeGreaterThan(0);
    } finally {
      copy.close();
    }
  });

  it('refuses to overwrite an existing target', () => {
    const dest = join(dir, 'snap.sqlite');
    backup(dir, dest, false);
    expect(() => backup(dir, dest, false)).toThrow(/already exists/);
  });

  it('errors clearly when no store exists', () => {
    const empty = mkdtempSync(join(tmpdir(), 'danni-empty-'));
    try {
      expect(() => backup(empty, join(empty, 'snap.sqlite'))).toThrow(/no danni\.sqlite/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
