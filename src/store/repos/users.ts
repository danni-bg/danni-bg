import type { Database } from 'bun:sqlite';
import { nowIso } from '../../lib/time.ts';
import { bumpDue } from './last-seen.ts';

export type UserRole = 'admin' | 'user';

export interface UserRow {
  id: string;
  kratos_identity_id: string;
  email: string;
  display_name: string | null;
  role: UserRole;
  email_verified: number; // SQLite boolean (0/1)
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
  token_limit: number | null; // per-user chat-token quota override (null = platform default)
  usage_reset_at: string | null; // start of the current usage window (null = all time)
  avatar_url: string | null; // optional profile picture (data: URL); null = initials
}

export interface FindOrCreateInput {
  kratosIdentityId: string;
  email: string;
  emailVerified?: boolean;
  displayName?: string | null;
  /** Tier to assign IF the row is created (e.g. admin bootstrap). Existing rows keep their role. */
  createRole?: UserRole;
  now?: string;
}

/**
 * App-side users keyed by the Kratos identity id. The identity itself lives in Kratos; this table
 * adds the access tier (`role`) and login bookkeeping. Mirrors the other repos: a plain class over
 * the shared `bun:sqlite` Database.
 */
export class UsersRepo {
  constructor(private readonly db: Database) {}

  get(id: string): UserRow | null {
    return this.db.query<UserRow, [string]>('SELECT * FROM users WHERE id = ?').get(id) ?? null;
  }

  findByKratosId(kratosIdentityId: string): UserRow | null {
    return (
      this.db
        .query<UserRow, [string]>('SELECT * FROM users WHERE kratos_identity_id = ?')
        .get(kratosIdentityId) ?? null
    );
  }

  findByEmail(email: string): UserRow | null {
    return this.db.query<UserRow, [string]>('SELECT * FROM users WHERE email = ?').get(email) ?? null;
  }

  /**
   * Find the user for a Kratos identity, creating it on first sight. Idempotent on
   * `kratos_identity_id`: an existing row has its email/verification refreshed and `last_login_at`
   * bumped (it keeps its role); a new row is inserted with `createRole` (default 'user').
   *
   * The `last_login_at` bump is throttled (spec 043 FR-254): in steady state — same profile,
   * within the window — this performs no write, so an authenticated read is not also a SQLite
   * write. A changed profile field (email/verification/display name) still writes immediately.
   */
  findOrCreateByKratosId(input: FindOrCreateInput): UserRow {
    const now = input.now ?? nowIso();
    const verified = input.emailVerified ? 1 : 0;
    const existing = this.findByKratosId(input.kratosIdentityId);
    if (existing) {
      const nameChanged = input.displayName != null && input.displayName !== existing.display_name;
      const profileChanged =
        existing.email !== input.email || existing.email_verified !== verified || nameChanged;
      const loginDue = bumpDue(existing.last_login_at, now);
      if (!profileChanged && !loginDue) return existing;
      // `display_name` is COALESCEd so a session carrying a name (the Kratos whoami path) keeps it
      // current after a profile edit, while one without (e.g. header-only) leaves the name intact.
      // `last_login_at` only advances when the throttle window has elapsed.
      const lastLogin = loginDue ? now : existing.last_login_at;
      this.db
        .query(
          'UPDATE users SET email = ?, email_verified = ?, display_name = COALESCE(?, display_name), last_login_at = ?, updated_at = ? WHERE id = ?',
        )
        .run(input.email, verified, input.displayName ?? null, lastLogin, now, existing.id);
      return this.get(existing.id) as UserRow;
    }
    const id = crypto.randomUUID();
    this.db
      .query(
        `INSERT INTO users (id, kratos_identity_id, email, display_name, role, email_verified, created_at, updated_at, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.kratosIdentityId,
        input.email,
        input.displayName ?? null,
        input.createRole ?? 'user',
        verified,
        now,
        now,
        now,
      );
    return this.get(id) as UserRow;
  }

  /** Set a user's tier by email. Returns true if a row was updated. Used by `danni admin-grant`. */
  setRoleByEmail(email: string, role: UserRole, now: string = nowIso()): boolean {
    const res = this.db
      .query('UPDATE users SET role = ?, updated_at = ? WHERE email = ?')
      .run(role, now, email);
    return res.changes > 0;
  }

  listAll(): UserRow[] {
    return this.db.query<UserRow, []>('SELECT * FROM users ORDER BY created_at').all();
  }

  /** Set (or clear, with null) a user's per-user token-quota override. Returns true if a row matched. */
  setTokenLimit(userId: string, limit: number | null, now: string = nowIso()): boolean {
    const res = this.db
      .query('UPDATE users SET token_limit = ?, updated_at = ? WHERE id = ?')
      .run(limit, now, userId);
    return res.changes > 0;
  }

  /** Reset a user's usage window to `now`, so their counted usage restarts. Returns true if matched. */
  resetUsage(userId: string, now: string = nowIso()): boolean {
    const res = this.db
      .query('UPDATE users SET usage_reset_at = ?, updated_at = ? WHERE id = ?')
      .run(now, now, userId);
    return res.changes > 0;
  }

  /** Set (or clear, with null) a user's profile picture. Returns true if a row matched. */
  setAvatar(userId: string, avatarUrl: string | null, now: string = nowIso()): boolean {
    const res = this.db
      .query('UPDATE users SET avatar_url = ?, updated_at = ? WHERE id = ?')
      .run(avatarUrl, now, userId);
    return res.changes > 0;
  }
}
