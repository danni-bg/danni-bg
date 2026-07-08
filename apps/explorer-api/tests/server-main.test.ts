// Bootstrap wiring (server.ts): main() loads config, opens the store, builds the app, and hands the
// serve options to Bun.serve. Driven with an injected serve fn so no socket is bound, and seedSettings
// is exercised directly (hermetic — a migrated temp store, no live LLM/Kratos).

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../../src/store/db.ts';
import { runMigrations } from '../../../src/store/migrate.ts';
import { PlatformSettingsRepo } from '../../../src/store/repos/platform-settings.ts';
import { LLM_SETTING_KEY } from '../src/admin/settings-schema.ts';
import { type ServeOptions, main, seedSettings } from '../src/server.ts';

const ROOT = new URL('../../..', import.meta.url).pathname;

describe('seedSettings', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'danni-seed-'));
  });
  const saved = { p: process.env.EXPLORER_DEFAULT_PROVIDER, m: process.env.EXPLORER_DEFAULT_MODEL };
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (saved.p === undefined) delete process.env.EXPLORER_DEFAULT_PROVIDER;
    else process.env.EXPLORER_DEFAULT_PROVIDER = saved.p;
    if (saved.m === undefined) delete process.env.EXPLORER_DEFAULT_MODEL;
    else process.env.EXPLORER_DEFAULT_MODEL = saved.m;
  });

  it('seeds the LLM default from EXPLORER_DEFAULT_* on first run', () => {
    const db = openDb({ storeRoot: dir, loadVec: false });
    runMigrations(db, join(ROOT, 'migrations'));
    const settings = new PlatformSettingsRepo(db);
    process.env.EXPLORER_DEFAULT_PROVIDER = 'openai-compatible';
    process.env.EXPLORER_DEFAULT_MODEL = 'seed-model';
    seedSettings(settings);
    expect((settings.get(LLM_SETTING_KEY) as { model: string }).model).toBe('seed-model');
    db.close();
  });

  it('does nothing when a setting already exists (settings store is authoritative)', () => {
    const db = openDb({ storeRoot: dir, loadVec: false });
    runMigrations(db, join(ROOT, 'migrations'));
    const settings = new PlatformSettingsRepo(db);
    settings.set(LLM_SETTING_KEY, {
      kind: 'openai-compatible',
      model: 'kept',
      baseUrl: null,
      apiKey: null,
    });
    process.env.EXPLORER_DEFAULT_PROVIDER = 'openai-compatible';
    process.env.EXPLORER_DEFAULT_MODEL = 'ignored';
    seedSettings(settings);
    expect((settings.get(LLM_SETTING_KEY) as { model: string }).model).toBe('kept');
    db.close();
  });

  it('does nothing when no env default is present', () => {
    const db = openDb({ storeRoot: dir, loadVec: false });
    runMigrations(db, join(ROOT, 'migrations'));
    const settings = new PlatformSettingsRepo(db);
    delete process.env.EXPLORER_DEFAULT_PROVIDER;
    delete process.env.EXPLORER_DEFAULT_MODEL;
    seedSettings(settings);
    expect(settings.get(LLM_SETTING_KEY)).toBeNull();
    db.close();
  });
});

describe('main()', () => {
  let dir: string;
  const savedStore = process.env.DANNI_STORE_ROOT;
  const savedPort = process.env.EXPLORER_API_PORT;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'danni-main-'));
    // Pre-migrate the store main() will open, so seedSettings' platform_settings read works.
    const db = openDb({ storeRoot: dir, loadVec: false });
    runMigrations(db, join(ROOT, 'migrations'));
    db.close();
    process.env.DANNI_STORE_ROOT = dir;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (savedStore === undefined) delete process.env.DANNI_STORE_ROOT;
    else process.env.DANNI_STORE_ROOT = savedStore;
    if (savedPort === undefined) delete process.env.EXPLORER_API_PORT;
    else process.env.EXPLORER_API_PORT = savedPort;
  });

  it('wires the app and passes serve options (default port) without binding a socket', async () => {
    delete process.env.EXPLORER_API_PORT;
    let captured: ServeOptions | undefined;
    main((opts) => {
      captured = opts;
      return undefined;
    });
    expect(captured?.port).toBe(8790);
    expect(captured?.idleTimeout).toBe(255);
    // The fetch handler is the wired Hono app — it answers the public health probe.
    const res = await captured?.fetch(new Request('http://localhost/healthz'));
    expect(res?.status).toBe(200);
    // /readyz drives the readiness closure main() wired into the context (server.ts) — DB reachable
    // + migrations current on the pre-migrated store.
    const ready = await captured?.fetch(new Request('http://localhost/readyz'));
    expect(ready?.status).toBe(200);
    const body = (await ready?.json()) as { ready: boolean; checks: { db: boolean } };
    expect(body.ready).toBe(true);
    expect(body.checks.db).toBe(true);
  });

  it('honors EXPLORER_API_PORT', () => {
    process.env.EXPLORER_API_PORT = '9123';
    let port = -1;
    main((opts) => {
      port = opts.port;
      return undefined;
    });
    expect(port).toBe(9123);
  });
});
