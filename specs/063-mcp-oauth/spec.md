# Spec 063 — MCP OAuth (user-delegated authorization for MCP)

## Problem

Spec 061's read `/mcp` authenticates with a machine API key; spec 062's admin `/mcp` **requires
user-delegated auth** (a machine key is forbidden). MCP's authorization is OAuth 2.1 — an MCP server is
an OAuth **Resource Server**, and clients obtain user-delegated access tokens from an **Authorization
Server**. danni has no OAuth AS today: it runs **Ory Kratos** (identity/sessions) + Oathkeeper, not
Hydra (OAuth2). This spec makes danni an OAuth 2.1 AS + Resource Server for MCP — the hard prerequisite
for 062, and a human-delegated path alongside API keys for 061.

## Design decision — the app IS its own OAuth 2.1 AS, backed by Kratos

Two ways to get an Authorization Server:

- **Ory Hydra** — the Ory-native OAuth2/OIDC server, pairs with Kratos for login/consent. Full-featured,
  but a whole new service + DB + operations to run — heavy for the open-core self-host story.
- **The app is the AS** — implemented via the MCP SDK's auth framework (`OAuthServerProvider` +
  `mcpAuthRouter` + `requireBearerAuth`), authenticating the human through the **existing Kratos
  session** (the app already validates it, spec 034). Self-contained, no new component, reuses the
  identity + user/role/tenant model danni already has.

**Recommend the second:** danni is BOTH the Authorization Server and the Resource Server (a common
combined deployment). The app's job is to implement the SDK's `OAuthServerProvider` against Kratos +
the app user store; the SDK provides the OAuth machinery. Hydra stays a documented "if you outgrow it"
swap (the SDK's `ProxyOAuthServerProvider` proxies to an external AS).

## Functional requirements

### Metadata + protocol (OAuth 2.1)

- **FR-480** danni serves AS + Protected-Resource metadata via the SDK's `mcpAuthRouter`:
  `/.well-known/oauth-authorization-server` (RFC 8414) and `/.well-known/oauth-protected-resource`
  (RFC 9728, advertising the MCP resource). **PKCE (S256) REQUIRED**; authorization-code grant only (no
  implicit). **Resource indicators (RFC 8707)** audience-bind each token to the MCP resource URI, so a
  danni-MCP token can't be replayed at another resource.
- **FR-481** **Dynamic Client Registration** (RFC 7591) at `/oauth/register` so MCP clients self-register
  (redirect URIs + client metadata), persisted in a new `oauth_clients` table. First-party clients (the
  SPA, known agents) may be pre-registered; a config allowlist MAY gate DCR.

### Authentication via the existing Kratos session (no new credential store)

- **FR-482** The authorize endpoint AUTHENTICATES the human via the EXISTING Kratos session (single-port
  whoami, spec 034 `sessionResolver`). An unauthenticated authorize redirects to the SPA login
  (`/auth/login?return_to=…`) and resumes; a valid session resolves the app `user` (find-or-create by
  Kratos identity, exactly as `requireAuth` does). No passwords/credentials live in the OAuth layer.
- **FR-483** **Consent** — the user approves the requested scope + client before a code is issued.
  First-party/pre-registered clients MAY auto-consent (config); a dynamically-registered (third-party)
  client MUST show a consent screen. Consent is per `(user, client, scope)`.

### Tokens — minimal, with FRESH authority

- **FR-484** Access tokens are SHORT-LIVED and app-signed (stateless JWT: `sub` = app user id,
  `aud` = the MCP resource, `scope`, `exp`, `jti`). The token carries **no role/tenant** — **role +
  active tenant are resolved FRESH per request** at the Resource Server (like `requireAuth`), so a
  demoted admin's still-valid token loses admin tools immediately. No stale authority is ever baked into
  a token.
- **FR-485** Refresh — v1 MAY ship access-token-only with a modest TTL (silent re-auth via the Kratos
  session); refresh tokens with rotation (RFC 9700) are a documented option, not required for v1.
- **FR-486** **Revocation** — `/oauth/revoke` (RFC 7009); a `jti` denylist (or the short TTL) bounds a
  revoked/aborted token. Disabling the Kratos identity or logout stops NEW tokens issuing; existing ones
  are bounded by TTL (and the denylist if immediate revocation is required).

### Resource-server integration

- **FR-487** The MCP endpoints validate the bearer via the SDK's `requireBearerAuth(provider)` →
  `req.auth` (`AuthInfo`) → the MCP tool `extra.authInfo`. `verifyAccessToken` checks signature +
  `aud` (resource) + `exp` + denylist, then resolves the app user fresh; invalid/expired/wrong-audience
  → `401`.
- **FR-488** `/mcp` (061) accepts EITHER an API key OR an OAuth bearer (OAuth adds the human-delegated
  path); `/admin/mcp` (062) accepts ONLY OAuth (API key → `403`). Scopes: `mcp:read` (read tools),
  `mcp:admin` (admin tools) — the GRANTED scope is the consented capability, the app ROLE (resolved
  fresh) is the authorization; a privileged tool requires BOTH.

## Non-goals / deferred

- OIDC id_tokens / userinfo — MCP needs OAuth access tokens for resource access, not OIDC login; out of
  scope.
- Full refresh-token rotation — fast-follow (v1 = short-TTL access tokens).
- Hydra integration (`ProxyOAuthServerProvider`) — documented alternative, not built.

## Dependencies

- Kratos identity + the app's session validation (019/034); the app user/role/tenant model (029/041);
  the MCP SDK auth framework (`OAuthServerProvider` / `mcpAuthRouter` / `requireBearerAuth`). Retrofits
  061's `/mcp`; unblocks 062's `/admin/mcp`.
- New tables: `oauth_clients`, `oauth_authorization_codes` (short-lived). Tokens are stateless JWT; a
  `oauth_revocations` (`jti`) denylist is optional (for immediate revocation).

## Testing (Constitution VIII — 100%)

- **Metadata**: both `.well-known` docs advertise the right endpoints + resource; PKCE-required and
  code-grant-only are enforced.
- **Flow**: full authorization-code + PKCE (S256) with a mock Kratos session → code → token; a bad PKCE
  verifier or a reused code fails.
- **Auth reuse**: authorize with no Kratos session → login redirect; with a session → resolves the app
  user.
- **DCR**: a client self-registers then authorizes; a non-allowlisted DCR (if gated) is rejected.
- **Token**: `verifyAccessToken` returns the right `AuthInfo`; wrong `aud` / expired / revoked → `401`;
  role/tenant resolved FRESH (a token minted as admin loses admin authorization after a demotion).
- **Consent**: a third-party client requires consent; a pre-registered one may auto-consent.
- **Resource binding**: a token minted for a different resource is rejected (RFC 8707).
