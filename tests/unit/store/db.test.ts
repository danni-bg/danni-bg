import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'bun:test';
import { loadVecExtension, openDb, withTransaction } from '../../../src/store/db.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

function vecPathExists(): boolean {
  const arch = process.arch;
  const platform = process.platform;
  let dir: string | null = null;
  if (platform === 'linux' && arch === 'x64') dir = 'linux-x64';
  else if (platform === 'linux' && arch === 'arm64') dir = 'linux-arm64';
  else if (platform === 'darwin' && arch === 'arm64') dir = 'macos-arm64';
  else if (platform === 'darwin' && arch === 'x64') dir = 'macos-x64';
  if (!dir) return false;
  const ext = platform === 'darwin' ? 'dylib' : 'so';
  return existsSync(join(ROOT, 'vendor', 'sqlite-vec', dir, `vec0.${ext}`));
}

describe('store.openDb', () => {
  it('creates the SQLite file under storeRoot with foreign_keys ON and WAL mode', () => {
    const root = globalThis.__TEST_TMP_DIR__;
    const db = openDb({ storeRoot: root, loadVec: false });
    try {
      const fk = db.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get();
      expect(fk?.foreign_keys).toBe(1);
      const jm = db.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get();
      expect((jm?.journal_mode ?? '').toLowerCase()).toBe('wal');
    } finally {
      db.close();
    }
  });

  it('uses a custom file name when provided', () => {
    const root = globalThis.__TEST_TMP_DIR__;
    const db = openDb({ storeRoot: root, loadVec: false, fileName: 'alt.sqlite' });
    db.close();
    expect(existsSync(join(root, 'alt.sqlite'))).toBe(true);
  });

  it('does not load sqlite-vec by default — opens on a clean checkout without the vendored binary', () => {
    // spec 050 FR-322 / SC-4: loadVec defaults to false, so openDb never touches the (absent)
    // vendored extension. Similarity search runs as in-process cosine over the cached matrix.
    const db = openDb({ storeRoot: globalThis.__TEST_TMP_DIR__ });
    try {
      expect(
        db.query<{ one: number }, []>('SELECT 1 AS one').get()?.one,
      ).toBe(1);
    } finally {
      db.close();
    }
  });

  it('throws when sqlite-vec extension is explicitly requested but missing', () => {
    if (vecPathExists()) {
      // operator has provisioned the extension — exercise the success path instead
      const db = openDb({ storeRoot: globalThis.__TEST_TMP_DIR__, loadVec: true });
      try {
        // The extension loaded without throwing; a trivial query confirms the handle is usable.
        // (`vecVersion` was removed as a dead export — spec 056 FR-391.)
        expect(db.query<{ x: number }, []>('SELECT 1 AS x').get()?.x).toBe(1);
      } finally {
        db.close();
      }
      return;
    }
    expect(() => openDb({ storeRoot: globalThis.__TEST_TMP_DIR__, loadVec: true })).toThrow(
      /sqlite-vec/,
    );
  });

  it('reaches the loadExtension call when the extension path exists (binary-independent)', () => {
    // The vendored vec0 binary is operator-supplied and absent in CI, so the success path of
    // loadVecExtension (the actual `db.loadExtension` call) is otherwise unreachable. Plant a file at
    // an injected path so `existsSync` passes and the load call runs; bun's loadExtension then rejects
    // the non-extension bytes — the point is that the call line executes, not that it succeeds.
    const p = join(globalThis.__TEST_TMP_DIR__, 'vec0.so');
    writeFileSync(p, '');
    const db = openDb({ storeRoot: globalThis.__TEST_TMP_DIR__, loadVec: false });
    try {
      expect(() => loadVecExtension(db, p)).toThrow();
    } finally {
      db.close();
    }
  });

  it('throws on unsupported platform/arch when loadVec is explicitly requested', () => {
    const original = { platform: process.platform, arch: process.arch };
    Object.defineProperty(process, 'platform', { value: 'sunos', configurable: true });
    Object.defineProperty(process, 'arch', { value: 'mips', configurable: true });
    try {
      expect(() => openDb({ storeRoot: globalThis.__TEST_TMP_DIR__, loadVec: true })).toThrow(
        /Unsupported platform/,
      );
    } finally {
      Object.defineProperty(process, 'platform', { value: original.platform, configurable: true });
      Object.defineProperty(process, 'arch', { value: original.arch, configurable: true });
    }
  });
});

describe('store.withTransaction', () => {
  it('commits when the function returns', () => {
    const db = openDb({ storeRoot: globalThis.__TEST_TMP_DIR__, loadVec: false });
    try {
      db.exec('CREATE TABLE x (id INTEGER);');
      withTransaction(db, () => {
        db.query('INSERT INTO x (id) VALUES (1)').run();
      });
      const row = db.query<{ id: number }, []>('SELECT id FROM x').get();
      expect(row?.id).toBe(1);
    } finally {
      db.close();
    }
  });

  it('rolls back when the function throws', () => {
    const db = openDb({ storeRoot: globalThis.__TEST_TMP_DIR__, loadVec: false });
    try {
      db.exec('CREATE TABLE x (id INTEGER);');
      expect(() =>
        withTransaction(db, () => {
          db.query('INSERT INTO x (id) VALUES (1)').run();
          throw new Error('rollback');
        }),
      ).toThrow(/rollback/);
      const row = db.query<{ id: number }, []>('SELECT id FROM x').get();
      expect(row).toBeNull();
    } finally {
      db.close();
    }
  });
});
