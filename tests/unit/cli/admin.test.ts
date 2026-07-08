import { describe, expect, it } from 'bun:test';
import { run } from '../../../src/cli/admin.ts';
import { UsersRepo } from '../../../src/store/repos/users.ts';
import {
  baseConfig,
  captureIO,
  tmpStore,
  withConfig,
  withMigratedStore,
  writeConfig,
} from './_cli-fixture.ts';

function seededConfig(email = 'a@b.bg'): string {
  const storeRoot = tmpStore();
  withMigratedStore(storeRoot, (db) => {
    new UsersRepo(db).findOrCreateByKratosId({ kratosIdentityId: 'k1', email });
  });
  return writeConfig(baseConfig(storeRoot));
}

describe('cli.admin run()', () => {
  it('rejects an unknown action with usage and exit 2', async () => {
    const io = captureIO();
    try {
      expect(await run(['bogus'])).toBe(2);
    } finally {
      io.restore();
    }
    expect(io.err.join('')).toContain('usage: danni admin');
  });

  it('lists users and exits 0', async () => {
    const cfg = seededConfig('lister@x.bg');
    const io = captureIO();
    let code: number;
    try {
      code = await withConfig(cfg, () => run(['list']));
    } finally {
      io.restore();
    }
    expect(code).toBe(0);
    expect(io.out.join('')).toContain('lister@x.bg');
  });

  it('grants and revokes an existing user', async () => {
    const cfg = seededConfig('grantme@x.bg');
    const io = captureIO();
    let grant: number;
    let revoke: number;
    try {
      grant = await withConfig(cfg, () => run(['grant', 'grantme@x.bg']));
      revoke = await withConfig(cfg, () => run(['revoke', 'grantme@x.bg']));
    } finally {
      io.restore();
    }
    expect(grant).toBe(0);
    expect(revoke).toBe(0);
    expect(io.out.join('')).toContain('grantme@x.bg -> admin');
    expect(io.out.join('')).toContain('grantme@x.bg -> user');
  });

  it('requires an email for grant/revoke (exit 2)', async () => {
    const cfg = seededConfig();
    const io = captureIO();
    try {
      expect(await withConfig(cfg, () => run(['grant']))).toBe(2);
    } finally {
      io.restore();
    }
    expect(io.err.join('')).toContain('usage: danni admin grant <email>');
  });

  it('returns 4 when the user does not exist', async () => {
    const cfg = seededConfig();
    const io = captureIO();
    try {
      expect(await withConfig(cfg, () => run(['grant', 'ghost@x.bg']))).toBe(4);
    } finally {
      io.restore();
    }
    expect(io.err.join('')).toContain('no user with email ghost@x.bg');
  });
});
