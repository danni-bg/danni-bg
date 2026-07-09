import type { Database } from 'bun:sqlite';
import { sha256Hex } from '../../lib/hash.ts';
import { nowIso } from '../../lib/time.ts';

// OAuth 2.1 Authorization-Server state for MCP (spec 063, migration 019): registered clients, the
// short-lived single-use authorization codes, and a revocation denylist. Access tokens are stateless
// JWTs (see apps/explorer-api/src/oauth/tokens.ts) — there is no token table. Plain classes over the
// shared bun:sqlite Database, matching the other repos.

function randomToken(bytes = 32): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Buffer.from(b).toString('base64url');
}

export type TokenEndpointAuthMethod = 'none' | 'client_secret_post';

export interface OAuthClient {
  id: string; // client_id
  clientName: string | null;
  redirectUris: string[];
  grantTypes: string[];
  scope: string | null; // space-delimited allowed scopes; null = all
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
  firstParty: boolean; // pre-registered → may auto-consent
}

interface ClientRow {
  id: string;
  secret_hash: string | null;
  client_name: string | null;
  redirect_uris: string;
  grant_types: string;
  scope: string | null;
  token_endpoint_auth_method: string;
  first_party: number;
  created_at: string;
}

function toClient(r: ClientRow): OAuthClient {
  return {
    id: r.id,
    clientName: r.client_name,
    redirectUris: JSON.parse(r.redirect_uris) as string[],
    grantTypes: JSON.parse(r.grant_types) as string[],
    scope: r.scope,
    tokenEndpointAuthMethod: r.token_endpoint_auth_method as TokenEndpointAuthMethod,
    firstParty: r.first_party === 1,
  };
}

export class OAuthClientsRepo {
  constructor(private db: Database) {}

  /** Register a client (DCR, RFC 7591). Returns the `client` + a one-time `clientSecret` for a
   *  confidential client (`client_secret_post`); public/PKCE clients get no secret. */
  register(input: {
    redirectUris: string[];
    grantTypes?: string[];
    scope?: string | null;
    tokenEndpointAuthMethod?: TokenEndpointAuthMethod;
    clientName?: string | null;
    firstParty?: boolean;
    now?: string;
    id?: string;
  }): { client: OAuthClient; clientSecret?: string } {
    const id = input.id ?? crypto.randomUUID();
    const method: TokenEndpointAuthMethod = input.tokenEndpointAuthMethod ?? 'none';
    let clientSecret: string | undefined;
    let secretHash: string | null = null;
    if (method === 'client_secret_post') {
      clientSecret = randomToken();
      secretHash = sha256Hex(clientSecret);
    }
    this.db
      .query(
        `INSERT INTO oauth_clients
          (id, secret_hash, client_name, redirect_uris, grant_types, scope, token_endpoint_auth_method, first_party, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        secretHash,
        input.clientName ?? null,
        JSON.stringify(input.redirectUris),
        JSON.stringify(input.grantTypes ?? ['authorization_code']),
        input.scope ?? null,
        method,
        input.firstParty ? 1 : 0,
        input.now ?? nowIso(),
      );
    const client = this.get(id);
    if (!client) throw new Error('client insert failed');
    return clientSecret ? { client, clientSecret } : { client };
  }

  get(id: string): OAuthClient | null {
    const r = this.db.query<ClientRow, [string]>('SELECT * FROM oauth_clients WHERE id = ?').get(id);
    return r ? toClient(r) : null;
  }

  /** Verify a confidential client's secret. Public clients (no stored secret) always fail here. */
  verifySecret(id: string, secret: string): boolean {
    const r = this.db
      .query<{ secret_hash: string | null }, [string]>('SELECT secret_hash FROM oauth_clients WHERE id = ?')
      .get(id);
    if (!r?.secret_hash) return false;
    return sha256Hex(secret) === r.secret_hash;
  }
}

export interface AuthCode {
  code: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string | null;
  resource: string | null;
}

interface CodeRow {
  code: string;
  client_id: string;
  user_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string | null;
  resource: string | null;
  expires_at: string;
  consumed_at: string | null;
}

export class OAuthCodesRepo {
  constructor(private db: Database) {}

  issue(input: {
    clientId: string;
    userId: string;
    redirectUri: string;
    codeChallenge: string;
    scope?: string | null;
    resource?: string | null;
    ttlSec: number;
    now?: number;
    code?: string;
  }): string {
    const code = input.code ?? randomToken(32);
    const now = input.now ?? Date.now();
    this.db
      .query(
        `INSERT INTO oauth_authorization_codes
          (code, client_id, user_id, redirect_uri, code_challenge, scope, resource, expires_at, consumed_at)
         VALUES (?,?,?,?,?,?,?,?,NULL)`,
      )
      .run(
        code,
        input.clientId,
        input.userId,
        input.redirectUri,
        input.codeChallenge,
        input.scope ?? null,
        input.resource ?? null,
        new Date(now + input.ttlSec * 1000).toISOString(),
      );
    return code;
  }

  /** Atomically consume a code: return it iff it exists, is unconsumed, and unexpired — marking it
   *  consumed so a replay returns null. The read + mark run in one transaction (single-use). */
  consume(code: string, now: number = Date.now()): AuthCode | null {
    const tx = this.db.transaction((): AuthCode | null => {
      const r = this.db
        .query<CodeRow, [string]>('SELECT * FROM oauth_authorization_codes WHERE code = ?')
        .get(code);
      if (!r || r.consumed_at || new Date(r.expires_at).getTime() <= now) return null;
      this.db
        .query('UPDATE oauth_authorization_codes SET consumed_at = ? WHERE code = ?')
        .run(new Date(now).toISOString(), code);
      return {
        code: r.code,
        clientId: r.client_id,
        userId: r.user_id,
        redirectUri: r.redirect_uri,
        codeChallenge: r.code_challenge,
        scope: r.scope,
        resource: r.resource,
      };
    });
    return tx();
  }
}

export class OAuthRevocationsRepo {
  constructor(private db: Database) {}

  revoke(jti: string, expiresAt: string, now?: string): void {
    this.db
      .query(
        'INSERT INTO oauth_revocations (jti, revoked_at, expires_at) VALUES (?,?,?) ON CONFLICT(jti) DO NOTHING',
      )
      .run(jti, now ?? nowIso(), expiresAt);
  }

  isRevoked(jti: string): boolean {
    const r = this.db
      .query<{ c: number }, [string]>('SELECT count(*) AS c FROM oauth_revocations WHERE jti = ?')
      .get(jti);
    return (r?.c ?? 0) > 0;
  }
}
