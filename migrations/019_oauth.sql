-- 019_oauth.sql — OAuth 2.1 Authorization-Server state for MCP (spec 063). danni is its own AS + RS:
-- an MCP agent, acting on a signed-in human's behalf, obtains a short-lived access token here and
-- presents it to /mcp. The human is authenticated via the EXISTING Kratos session (no credential
-- store here). Access tokens are STATELESS app-signed JWTs (no token table); these tables hold only
-- the registered clients, the short-lived authorization codes, and a revocation denylist.

-- Registered OAuth clients (Dynamic Client Registration, RFC 7591; first-party clients seeded).
CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,                                  -- client_id
  secret_hash TEXT,                                     -- SHA-256 of client_secret (confidential); NULL = public/PKCE
  client_name TEXT,
  redirect_uris TEXT NOT NULL,                          -- JSON array of exact redirect URIs
  grant_types TEXT NOT NULL,                            -- JSON array (authorization_code[, refresh_token])
  scope TEXT,                                           -- space-delimited allowed scopes (NULL = all)
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',  -- none (public + PKCE) | client_secret_post
  first_party INTEGER NOT NULL DEFAULT 0,              -- 1 = pre-registered → may auto-consent
  created_at TEXT NOT NULL
);

-- Short-lived, single-use authorization codes (the code → token exchange, PKCE-bound).
CREATE TABLE oauth_authorization_codes (
  code TEXT PRIMARY KEY,                                -- opaque code
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,                                -- app user (the token subject)
  redirect_uri TEXT NOT NULL,                           -- must match on exchange
  code_challenge TEXT NOT NULL,                         -- PKCE S256 challenge (verifier checked on exchange)
  scope TEXT,                                           -- granted scope (space-delimited)
  resource TEXT,                                        -- RFC 8707 resource indicator (audience)
  expires_at TEXT NOT NULL,                             -- short TTL (≈60s)
  consumed_at TEXT                                      -- set on first exchange → replay is rejected
);
CREATE INDEX oauth_codes_expiry_idx ON oauth_authorization_codes (expires_at);

-- Revocation denylist for still-valid (unexpired) access tokens (RFC 7009). Pruned past expires_at;
-- the short access-token TTL bounds the window regardless.
CREATE TABLE oauth_revocations (
  jti TEXT PRIMARY KEY,                                 -- revoked access-token id
  revoked_at TEXT NOT NULL,
  expires_at TEXT NOT NULL                              -- the token's own exp; safe to prune after
);
CREATE INDEX oauth_revocations_expiry_idx ON oauth_revocations (expires_at);
