import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../migrate.ts';
import { OAuthClientsRepo, OAuthCodesRepo, OAuthRevocationsRepo } from './oauth.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

describe('OAuth repos (spec 063)', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, join(ROOT, 'migrations'));
  });
  afterEach(() => db.close());

  describe('clients', () => {
    it('registers a public (PKCE) client with no secret', () => {
      const repo = new OAuthClientsRepo(db);
      const { client, clientSecret } = repo.register({ redirectUris: ['https://c/cb'], clientName: 'c' });
      expect(clientSecret).toBeUndefined();
      expect(client.tokenEndpointAuthMethod).toBe('none');
      expect(client.redirectUris).toEqual(['https://c/cb']);
      expect(client.grantTypes).toEqual(['authorization_code']);
      expect(client.firstParty).toBe(false);
      expect(repo.get(client.id)?.id).toBe(client.id);
      expect(repo.verifySecret(client.id, 'anything')).toBe(false); // public client has no secret
    });

    it('registers a confidential client and verifies its secret', () => {
      const repo = new OAuthClientsRepo(db);
      const { client, clientSecret } = repo.register({
        redirectUris: ['https://c/cb'],
        tokenEndpointAuthMethod: 'client_secret_post',
        firstParty: true,
      });
      expect(clientSecret).toBeString();
      expect(client.firstParty).toBe(true);
      expect(repo.verifySecret(client.id, clientSecret as string)).toBe(true);
      expect(repo.verifySecret(client.id, 'wrong')).toBe(false);
    });

    it('returns null for an unknown client', () => {
      expect(new OAuthClientsRepo(db).get('nope')).toBeNull();
    });
  });

  describe('authorization codes', () => {
    const T0 = 1_800_000_000_000;
    const base = {
      clientId: 'c1',
      userId: 'u1',
      redirectUri: 'https://c/cb',
      codeChallenge: 'chal',
      scope: 'mcp:read',
      resource: 'https://d/mcp',
      ttlSec: 60,
    };

    it('consumes a valid code exactly once', () => {
      const repo = new OAuthCodesRepo(db);
      const code = repo.issue({ ...base, now: T0, code: 'code-1' });
      const first = repo.consume(code, T0 + 1000);
      expect(first?.userId).toBe('u1');
      expect(first?.codeChallenge).toBe('chal');
      expect(first?.resource).toBe('https://d/mcp');
      // Replay → null.
      expect(repo.consume(code, T0 + 2000)).toBeNull();
    });

    it('rejects an expired code', () => {
      const repo = new OAuthCodesRepo(db);
      const code = repo.issue({ ...base, now: T0, code: 'code-2' });
      expect(repo.consume(code, T0 + 61_000)).toBeNull();
    });

    it('returns null for an unknown code', () => {
      expect(new OAuthCodesRepo(db).consume('missing', T0)).toBeNull();
    });
  });

  describe('revocations', () => {
    it('records and reports a revoked jti (idempotent)', () => {
      const repo = new OAuthRevocationsRepo(db);
      expect(repo.isRevoked('j1')).toBe(false);
      repo.revoke('j1', '2030-01-01T00:00:00Z');
      repo.revoke('j1', '2030-01-01T00:00:00Z'); // ON CONFLICT DO NOTHING
      expect(repo.isRevoked('j1')).toBe(true);
      expect(repo.isRevoked('j2')).toBe(false);
    });
  });
});
