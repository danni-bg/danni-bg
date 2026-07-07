// Spec 056 SC-5 (/api/admin): the admin list endpoints (`/usage`, `/tenants`, `/api-usage`) honor
// limit/offset and return `total` — no unbounded full-table dump. Hermetic via createApp + injected
// identity headers.

import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Crosswalk } from '../../../packages/geo-boundaries/src/crosswalk.ts';
import { loadCrosswalk } from '../../../packages/geo-boundaries/src/load.ts';
import { runMigrations } from '../../../src/store/migrate.ts';
import { ApiUsageRepo } from '../../../src/store/repos/api-usage.ts';
import { PlatformSettingsRepo } from '../../../src/store/repos/platform-settings.ts';
import { TenantsRepo } from '../../../src/store/repos/tenants.ts';
import { TokenUsageRepo } from '../../../src/store/repos/token-usage.ts';
import { UsersRepo } from '../../../src/store/repos/users.ts';
import { type AppContext, createApp } from '../src/app.ts';
import type { ReadBridge } from '../src/read-bridge.ts';

beforeAll(() => {
  process.env.TRUST_PROXY_AUTH_HEADERS = 'true';
});
afterAll(() => {
  delete process.env.TRUST_PROXY_AUTH_HEADERS;
});

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const ADMIN = {
  'content-type': 'application/json',
  'x-user-id': 'admin-k',
  'x-user-email': 'admin@example.com',
  'x-user-verified': 'true',
};

function setup() {
  const db = new Database(':memory:');
  runMigrations(db, join(ROOT, 'migrations'));
  const users = new UsersRepo(db);
  users.findOrCreateByKratosId({ kratosIdentityId: 'admin-k', email: 'admin@example.com' });
  users.setRoleByEmail('admin@example.com', 'admin');
  // Two more users so the /usage list has > 2 rows.
  users.findOrCreateByKratosId({ kratosIdentityId: 'u2', email: 'u2@example.com' });
  users.findOrCreateByKratosId({ kratosIdentityId: 'u3', email: 'u3@example.com' });

  // Two more tenants (the migration already seeds `default`) → 3 total.
  const tenants = new TenantsRepo(db);
  tenants.create({ name: 'Org A', slug: 'org-a' });
  tenants.create({ name: 'Org B', slug: 'org-b' });

  // Three distinct API-usage principals.
  const apiUsage = new ApiUsageRepo(db);
  for (const id of ['p1', 'p2', 'p3']) {
    apiUsage.record({ principalKind: 'user', principalId: id, routeClass: 'data' });
  }

  const ctx: AppContext = {
    bridge: {} as ReadBridge,
    crosswalk: new Crosswalk(loadCrosswalk()),
    health: () => ({ lastSyncedAt: null, isStale: true, defaultProvider: 'absent' }),
    users,
    settings: new PlatformSettingsRepo(db),
    tokenUsage: new TokenUsageRepo(db),
    tenants,
    apiUsage,
  };
  return { db, app: createApp(ctx) };
}

describe('spec 056 SC-5: admin list endpoints paginate + return total', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });
  afterEach(() => s.db.close());

  const get = async (path: string) =>
    (await (await s.app.request(path, { headers: ADMIN })).json()) as {
      total: number;
      limit: number;
      offset: number;
    } & Record<string, unknown>;

  it('/api/admin/usage honors limit/offset and returns total', async () => {
    const all = await get('/api/admin/usage');
    expect(all.total).toBe(3);
    expect((all.users as unknown[]).length).toBe(3);

    const page = await get('/api/admin/usage?limit=2');
    expect((page.users as unknown[]).length).toBe(2);
    expect(page.total).toBe(3);
    expect(page.limit).toBe(2);

    const rest = await get('/api/admin/usage?limit=2&offset=2');
    expect((rest.users as unknown[]).length).toBe(1);
  });

  it('/api/admin/tenants honors limit/offset and returns total', async () => {
    const all = await get('/api/admin/tenants');
    expect(all.total).toBe(3); // default + Org A + Org B
    expect((all.tenants as unknown[]).length).toBe(3);

    const page = await get('/api/admin/tenants?limit=2');
    expect((page.tenants as unknown[]).length).toBe(2);
    expect(page.total).toBe(3);
  });

  it('/api/admin/api-usage honors limit/offset and returns total', async () => {
    const all = await get('/api/admin/api-usage');
    expect(all.total).toBe(3);
    expect((all.principals as unknown[]).length).toBe(3);

    const page = await get('/api/admin/api-usage?limit=2');
    expect((page.principals as unknown[]).length).toBe(2);
    expect(page.total).toBe(3);
  });
});
