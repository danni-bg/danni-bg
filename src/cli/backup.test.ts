import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  it('throws when integrity_check does not return ok', () => {
    // Force the verification failure branch by stubbing Database.prototype.query for the copy handle.
    const dest = join(dir, 'corrupt.sqlite');
    const origQuery = Database.prototype.query;
    // Only override the readonly verification handle's integrity_check probe.
    (Database.prototype as unknown as { query: unknown }).query = function patched(
      this: Database,
      sql: string,
    ) {
      const real = origQuery.call(this, sql) as { get: () => unknown };
      if (sql.includes('integrity_check')) {
        return { get: () => ({ integrity_check: 'malformed' }) } as never;
      }
      return real as never;
    };
    try {
      expect(() => backup(dir, dest, false)).toThrow(/integrity_check returned "malformed"/);
    } finally {
      (Database.prototype as unknown as { query: unknown }).query = origQuery;
    }
  });
});

describe('danni backup run() (spec 043)', () => {
  let dir: string;
  let origWrite: typeof process.stdout.write;
  const captured: string[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'danni-backup-run-'));
    const db = new Database(join(dir, 'danni.sqlite'), { create: true, readwrite: true });
    db.exec('PRAGMA journal_mode = WAL;');
    runMigrations(db, join(ROOT, 'migrations'));
    db.close();
    captured.length = 0;
    origWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write;
  });
  afterEach(() => {
    process.stdout.write = origWrite;
    rmSync(dir, { recursive: true, force: true });
  });

  async function withConfig<T>(storeRoot: string, fn: () => Promise<T>): Promise<T> {
    const cfgPath = join(dir, 'danni.config.json');
    writeFileSync(
      cfgPath,
      JSON.stringify({
        portal: { baseUrl: 'https://data.egov.bg/api/3/action/' },
        crawler: {
          userAgent: 'danni-bg/test',
          rateLimit: { requestsPerSecondPerHost: 1 },
          concurrency: { maxConcurrentRequestsPerHost: 4 },
          backoff: { initialMs: 500, maxMs: 60000, failureBudget: 20 },
          robots: { recheckIntervalSeconds: 86400 },
        },
        store: { root: storeRoot },
        schedule: {
          enabled: false,
          cron: null,
          onOverlap: 'skip',
          failureRateThreshold: 0.05,
          notifier: { kind: 'stderr' },
        },
        scope: {},
        enrichment: {
          translator: { provider: 'local-marianmt' },
          embedder: { provider: 'local-onnx', batchSize: 32 },
        },
        index: { incremental: true },
      }),
    );
    const prev = process.env.DANNI_CONFIG;
    process.env.DANNI_CONFIG = cfgPath;
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.DANNI_CONFIG;
      else process.env.DANNI_CONFIG = prev;
    }
  }

  it('writes a snapshot and prints a human summary (default loadVec runs against a vec-free store)', async () => {
    const code = await withConfig(dir, () => run([join(dir, 'snap-human.sqlite')]));
    expect(code).toBe(0);
    const out = captured.join('');
    expect(out).toContain('backup written:');
    expect(out).toContain('integrity_check: ok');
  });

  it('emits JSON with --json', async () => {
    const code = await withConfig(dir, () => run([join(dir, 'snap-json.sqlite'), '--json']));
    expect(code).toBe(0);
    const result = JSON.parse(captured.join('')) as { integrity: string };
    expect(result.integrity).toBe('ok');
  });
});
