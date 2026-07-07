import { describe, expect, it } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, parseConfig } from '../../../src/config/loader.ts';
import { ConfigError } from '../../../src/lib/errors.ts';

const VALID = {
  portal: { baseUrl: 'https://data.egov.bg/api/3/action/' },
  crawler: {
    userAgent: 'danni-bg/0.1.0 (+https://example.com)',
    rateLimit: { requestsPerSecondPerHost: 1 },
    concurrency: { maxConcurrentRequestsPerHost: 4 },
    backoff: { initialMs: 500, maxMs: 60000, failureBudget: 20 },
    robots: { recheckIntervalSeconds: 86400 },
  },
  store: { root: './store' },
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
    embedder: { provider: 'local-onnx' },
  },
  index: { incremental: true },
};

describe('config.parseConfig', () => {
  it('accepts a fully-valid config and applies defaults', () => {
    const cfg = parseConfig(VALID);
    expect(cfg.store.freshnessSloSeconds).toBe(86400);
    expect(cfg.schedule.onOverlap).toBe('skip');
  });

  it('rejects a missing required field', () => {
    const bad = { ...VALID, portal: {} };
    expect(() => parseConfig(bad)).toThrow(ConfigError);
  });

  it('rejects invalid enum values', () => {
    const bad = { ...VALID, schedule: { ...VALID.schedule, onOverlap: 'wat' } };
    expect(() => parseConfig(bad)).toThrow(ConfigError);
  });

  // spec 056 FR-388: the removed `schedule.timezone` key must fail loudly under the strict schema
  // (cron fires in server-local time) rather than being silently ignored.
  it('rejects a config carrying the removed schedule.timezone key (FR-388)', () => {
    const bad = { ...VALID, schedule: { ...VALID.schedule, timezone: 'Europe/Sofia' } };
    expect(() => parseConfig(bad)).toThrow(ConfigError);
  });

  // spec 056 FR-389: `onOverlap: 'queue'` was indistinguishable from 'skip' and is removed from the
  // enum; a config still using it must be rejected (the error names 'skip' as the valid value).
  it("rejects onOverlap:'queue' (removed enum value, FR-389)", () => {
    const bad = { ...VALID, schedule: { ...VALID.schedule, onOverlap: 'queue' } };
    expect(() => parseConfig(bad)).toThrow(ConfigError);
  });

  it('requires schedule.cron when schedule.enabled=true', () => {
    const bad = {
      ...VALID,
      schedule: { ...VALID.schedule, enabled: true, cron: null },
    };
    expect(() => parseConfig(bad)).toThrow(ConfigError);
  });

  it('accepts schedule.enabled=true with a cron string', () => {
    const ok = {
      ...VALID,
      schedule: { ...VALID.schedule, enabled: true, cron: '0 3 * * *' },
    };
    const cfg = parseConfig(ok);
    expect(cfg.schedule.cron).toBe('0 3 * * *');
  });

  it('rejects unknown top-level keys', () => {
    expect(() => parseConfig({ ...VALID, extra: 1 })).toThrow(ConfigError);
  });
});

describe('config.loadConfig', () => {
  it('reads JSON from disk and validates it', () => {
    const path = join(globalThis.__TEST_TMP_DIR__, 'danni.config.json');
    writeFileSync(path, JSON.stringify(VALID));
    const cfg = loadConfig({ path });
    expect(cfg.portal.baseUrl).toBe('https://data.egov.bg/api/3/action/');
  });

  it('honors DANNI_CONFIG env override', () => {
    const path = join(globalThis.__TEST_TMP_DIR__, 'alt.config.json');
    writeFileSync(path, JSON.stringify(VALID));
    const cfg = loadConfig({ env: { DANNI_CONFIG: path } });
    expect(cfg.store.root).toBe('./store');
  });

  it('throws ConfigError for a missing file', () => {
    expect(() => loadConfig({ path: '/no/such/danni.config.json' })).toThrow(ConfigError);
  });

  it('throws ConfigError for invalid JSON', () => {
    const path = join(globalThis.__TEST_TMP_DIR__, 'bad.json');
    writeFileSync(path, '{not json');
    expect(() => loadConfig({ path })).toThrow(ConfigError);
  });

  it('throws ConfigError for invalid schema with field-level details', () => {
    const path = join(globalThis.__TEST_TMP_DIR__, 'bad.json');
    writeFileSync(path, JSON.stringify({ portal: {} }));
    try {
      loadConfig({ path });
      throw new Error('should not reach');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const issues = (err as ConfigError).details['issues'];
      expect(Array.isArray(issues)).toBe(true);
    }
  });

  it('resolves a relative path against cwd', () => {
    const path = join(globalThis.__TEST_TMP_DIR__, 'rel.config.json');
    writeFileSync(path, JSON.stringify(VALID));
    const cfg = loadConfig({ cwd: globalThis.__TEST_TMP_DIR__, path: 'rel.config.json' });
    expect(cfg.crawler.userAgent).toContain('danni-bg');
  });
});
