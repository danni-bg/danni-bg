import type { Database } from 'bun:sqlite';
import { nowIso } from '../../lib/time.ts';

// Admin audit trail (spec 062, migration 020): one row per administrative MUTATION. A plain class over
// the shared bun:sqlite Database, matching the other repos. The record + read are used by the admin MCP
// (spec 062) and — via the same helper — the equivalent REST admin routes, so the trail is complete.

export type AuditOutcome = 'ok' | 'denied' | 'error';

export interface AuditRecord {
  id: string;
  actorUserId: string;
  actorRole: string;
  tenantId: string | null;
  action: string;
  target: string | null;
  detail: unknown;
  outcome: AuditOutcome;
  createdAt: string;
}

interface AuditRow {
  id: string;
  actor_user_id: string;
  actor_role: string;
  tenant_id: string | null;
  action: string;
  target: string | null;
  detail_json: string | null;
  outcome: string;
  created_at: string;
}

function toRecord(r: AuditRow): AuditRecord {
  return {
    id: r.id,
    actorUserId: r.actor_user_id,
    actorRole: r.actor_role,
    tenantId: r.tenant_id,
    action: r.action,
    target: r.target,
    detail: r.detail_json != null ? JSON.parse(r.detail_json) : null,
    outcome: r.outcome as AuditOutcome,
    createdAt: r.created_at,
  };
}

export class AdminAuditRepo {
  constructor(private db: Database) {}

  record(input: {
    actorUserId: string;
    actorRole: string;
    tenantId?: string | null;
    action: string;
    target?: string | null;
    detail?: unknown;
    outcome: AuditOutcome;
    now?: string;
  }): string {
    const id = crypto.randomUUID();
    this.db
      .query(
        `INSERT INTO admin_audit (id, actor_user_id, actor_role, tenant_id, action, target, detail_json, outcome, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.actorUserId,
        input.actorRole,
        input.tenantId ?? null,
        input.action,
        input.target ?? null,
        input.detail !== undefined ? JSON.stringify(input.detail) : null,
        input.outcome,
        input.now ?? nowIso(),
      );
    return id;
  }

  /** Most-recent-first page + total count (super-admin `list_audit`). */
  list(opts: { limit: number; offset: number }): { items: AuditRecord[]; total: number } {
    const total =
      this.db.query<{ c: number }, []>('SELECT count(*) AS c FROM admin_audit').get()?.c ?? 0;
    const rows = this.db
      .query<AuditRow, [number, number]>(
        'SELECT * FROM admin_audit ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
      )
      .all(opts.limit, opts.offset);
    return { items: rows.map(toRecord), total };
  }
}
