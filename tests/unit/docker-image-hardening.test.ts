import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Hermetic, source-level regression guard for spec 044 (runtime image hardening). It complements the
// CI docker-content guard (which asserts against the BUILT image, FR-264) by failing fast — in the
// always-on `bun test` gate, no docker needed — if a careless edit reintroduces the root/full-stage
// image. It reads the Dockerfile + .dockerignore and asserts the shape the FRs mandate.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf-8');
const dockerignore = readFileSync(join(ROOT, '.dockerignore'), 'utf-8');

describe('runtime image hardening (spec 044)', () => {
  it('FR-260: installs production-only deps and never dev/SPA-build packages in the runtime layer', () => {
    // A dedicated production install feeds the runtime node_modules.
    expect(dockerfile).toMatch(/bun install --frozen-lockfile --production/);
    // The runtime node_modules come from that prod-only layer, not the full build stage.
    expect(dockerfile).toMatch(/COPY --from=deps \/app\/node_modules \.\/node_modules/);
  });

  it('FR-261: copies an explicit allowlist, never the whole build stage', () => {
    // The old whole-stage copy MUST be gone.
    expect(dockerfile).not.toMatch(/COPY --from=build \/app \/app/);
    // Runtime-needed paths are each copied explicitly.
    for (const p of [
      'COPY src ./src',
      'COPY apps/explorer-api/src ./apps/explorer-api/src',
      'apps/explorer-web/dist ./apps/explorer-web/dist',
      'COPY packages ./packages',
      'COPY migrations ./migrations',
      'COPY scripts ./scripts',
      'COPY vendor ./vendor',
      'COPY bin ./bin',
    ]) {
      expect(dockerfile).toContain(p);
    }
    // Only the built SPA is shipped — never the SPA source tree.
    expect(dockerfile).not.toMatch(/COPY apps\/explorer-web\/src/);
    // Non-runtime trees are held out of the build context entirely.
    for (const deny of ['specs/', 'tests/', 'eval/', '**/*.test.ts']) {
      expect(dockerignore).toContain(deny);
    }
  });

  it('FR-262: runs as a dedicated non-root user with a fixed uid', () => {
    // A USER directive with a fixed, non-zero uid.
    const userMatch = dockerfile.match(/^USER\s+(\d+)/m);
    expect(userMatch).not.toBeNull();
    expect(Number(userMatch?.[1])).toBeGreaterThan(0);
    // The uid is created and owns /app + /data so the store is writable on a fresh volume.
    expect(dockerfile).toMatch(/useradd .*--uid 10001/);
    expect(dockerfile).toMatch(/chown -R danni:danni \/app \/data/);
  });

  it('FR-263: preserves the migrate-on-boot entrypoint contract', () => {
    expect(dockerfile).toMatch(/ENTRYPOINT \["\.\/scripts\/docker-entrypoint\.sh"\]/);
    expect(dockerfile).toMatch(/ENV[\s\S]*DANNI_PROFILE=production/);
    expect(dockerfile).toMatch(/DANNI_STORE_ROOT=\/data/);
    expect(dockerfile).toMatch(/VOLUME \["\/data"\]/);
    expect(dockerfile).toMatch(/EXPOSE 8790/);
  });
});
