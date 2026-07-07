import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../../../src/config/loader.ts';

// Spec 047 FR-291/FR-290: the committed example config MUST parse through the config schema and be
// self-host-correct against the flagship portal (data.egov.bg) so a fresh self-hoster's first
// `cp danni.config.example.json danni.config.json && danni sync` works with no edits (SC-1).
const REPO_ROOT = resolve(import.meta.dir, '../../..');
const EXAMPLE_PATH = resolve(REPO_ROOT, 'danni.config.example.json');

describe('danni.config.example.json', () => {
  it('parses through the config schema (never drifts invalid)', () => {
    // loadConfig runs the full DanniConfigSchema; a schema drift throws ConfigError here.
    const cfg = loadConfig({ path: EXAMPLE_PATH });
    expect(cfg.portal.baseUrl).toBeTruthy();
  });

  it('targets data.egov.bg with the custom adapter (portal-consistent, FR-290)', () => {
    const cfg = loadConfig({ path: EXAMPLE_PATH });
    // data.egov.bg does NOT serve the CKAN Action API — it needs the 'egov-bg' adapter at /api/.
    expect(cfg.portal.api).toBe('egov-bg');
    expect(cfg.portal.baseUrl).toBe('https://data.egov.bg/api/');
    // The CKAN Action path (…/api/3/action/) would silently fail against this portal.
    expect(cfg.portal.baseUrl).not.toContain('/action');
  });

  it('keeps conservative, portable self-host defaults', () => {
    const cfg = loadConfig({ path: EXAMPLE_PATH });
    expect(cfg.crawler.robots.obey).toBe(true);
    // Relative store path — no host-specific absolute path leaks into the committed shape.
    expect(cfg.store.root.startsWith('/')).toBe(false);
  });

  it('is valid JSON (no comments — comments live in the quickstart)', () => {
    const raw = readFileSync(EXAMPLE_PATH, 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});
