-- 020_admin_audit.sql — audit trail for administrative MUTATIONS (spec 062, FR-472). Every mutating
-- admin action (via the admin MCP, and — through the shared helper — the equivalent REST route) writes
-- one row: who did what, to which target, in which org, and the outcome. Read-only admin queries do
-- NOT audit. A super-admin `list_audit` tool + view reads it.
CREATE TABLE admin_audit (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL,      -- the app user who performed the action
  actor_role TEXT NOT NULL,         -- their app role at the time (admin | user)
  tenant_id TEXT,                   -- the active org the action ran in (NULL for a cross-org super-admin op)
  action TEXT NOT NULL,             -- tool/route name, e.g. 'revoke_api_key'
  target TEXT,                      -- primary target id (key id, member user id, tenant id, …)
  detail_json TEXT,                 -- argument summary / before→after (JSON)
  outcome TEXT NOT NULL,            -- 'ok' | 'denied' | 'error'
  created_at TEXT NOT NULL
);
CREATE INDEX admin_audit_created_idx ON admin_audit (created_at);
CREATE INDEX admin_audit_actor_idx ON admin_audit (actor_user_id);
