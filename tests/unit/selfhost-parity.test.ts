import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Spec 047: everything this repo references or promises must exist in this repo (or be explicitly
// marked commercial). This guard locks the fixes so the next split-style refactor can't silently
// reintroduce a dangling deploy-repo pointer or break the self-host building blocks.
const REPO_ROOT = resolve(import.meta.dir, '../..');
const read = (rel: string) => readFileSync(resolve(REPO_ROOT, rel), 'utf-8');

// FR-292 / SC-2: the operator-facing files that named the moved-out commercial paths. (specs/ and
// CLAUDE.md history are exempt — they record decisions as-of their date.)
const OPERATOR_FACING = [
  'apps/explorer-api/src/metrics.ts',
  'apps/explorer-api/src/trace.ts',
  'apps/explorer-api/src/app.ts',
  '.env.example',
  'README.md',
];

// The known dangling repo-relative paths the open-core split left behind (both moved to the private
// danni-bg/deploy repo). Neither exists here.
const DANGLING = ['infra/observability', 'docs/OPERATIONS.md'];

describe('self-host parity (spec 047)', () => {
  it('FR-292: no operator-facing file references a moved-out commercial path', () => {
    for (const file of OPERATOR_FACING) {
      const text = read(file);
      for (const ref of DANGLING) {
        expect(`${file}: ${text.includes(ref)}`).toBe(`${file}: false`);
      }
    }
  });

  it('FR-292: the named dangling paths genuinely do not exist in-repo', () => {
    for (const ref of DANGLING) {
      expect(existsSync(resolve(REPO_ROOT, ref))).toBe(false);
    }
  });

  it('FR-293: the self-host building blocks the README promises all exist', () => {
    for (const path of [
      'Dockerfile',
      'docker-compose.yml',
      'docker-compose.prod.yml',
      'infra/ory/README.md',
      'scripts/docker-entrypoint.sh',
      'scripts/smoke-selfhost.sh',
      'danni.config.example.json',
    ]) {
      expect(`${path}: ${existsSync(resolve(REPO_ROOT, path))}`).toBe(`${path}: true`);
    }
  });

  it('FR-294: the README lists the commercial-only layer in one place', () => {
    const readme = read('README.md');
    // A single "Open core" list naming what stays commercial (marked-commercial in one place).
    expect(readme).toContain('danni-bg/deploy');
    expect(readme.toLowerCase()).toContain('operations runbook');
    expect(readme.toLowerCase()).toContain('managed hosting');
  });
});
