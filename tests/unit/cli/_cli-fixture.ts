import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../../../src/store/db.ts';
import { runMigrations } from '../../../src/store/migrate.ts';

export const MIGRATIONS = fileURLToPath(new URL('../../../migrations', import.meta.url));

/** A minimal, schema-valid config. Merge `overrides` (shallow, per top-level key) as needed. */
export function baseConfig(storeRoot: string): Record<string, unknown> {
  return {
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
  };
}

/** Write a config file to the shared temp dir and return its path. */
export function writeConfig(config: Record<string, unknown>): string {
  const path = join(globalThis.__TEST_TMP_DIR__, `cfg-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(config));
  return path;
}

/** A fresh temp store dir path (not created on disk). */
export function tmpStore(): string {
  return join(globalThis.__TEST_TMP_DIR__, `store-${Math.random().toString(36).slice(2)}`);
}

/** Open + migrate a temp store, run `fn`, then close. Returns whatever `fn` returns. */
export function withMigratedStore<T>(
  storeRoot: string,
  fn: (db: ReturnType<typeof openDb>) => T,
): T {
  const db = openDb({ storeRoot, loadVec: false });
  try {
    runMigrations(db, MIGRATIONS);
    return fn(db);
  } finally {
    db.close();
  }
}

/** Point `DANNI_CONFIG` at `cfgPath` for the duration of `fn`, then restore. */
export async function withConfig<T>(cfgPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.DANNI_CONFIG;
  process.env.DANNI_CONFIG = cfgPath;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.DANNI_CONFIG;
    else process.env.DANNI_CONFIG = prev;
  }
}

export interface Captured {
  out: string[];
  err: string[];
  restore: () => void;
}

/** Capture process.stdout/stderr writes. Call `restore()` (or use captureIO + try/finally). */
export function captureIO(): Captured {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stderr.write;
  return {
    out,
    err,
    restore: () => {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    },
  };
}
