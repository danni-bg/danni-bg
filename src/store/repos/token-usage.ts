import type { Database } from 'bun:sqlite';
import { nowIso } from '../../lib/time.ts';
import { DEFAULT_TENANT_ID } from './tenants.ts';

export interface TokenUsageInput {
  userId: string;
  tenantId?: string; // owning org (spec 029); defaults to the default tenant
  sessionId?: string | null;
  model?: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Portion of inputTokens served from the provider's prompt cache. */
  cachedInputTokens?: number;
  now?: string;
}

export interface UserUsage {
  used: number; // total tokens since the user's reset window
  input: number;
  output: number;
  cached: number; // cache-hit input tokens (a subset of `input`)
  requests: number;
  lastUsedAt: string | null;
}

/** Per-user usage joined with the user's tier + effective limit, for the admin overview. */
export interface UserUsageRow {
  userId: string;
  email: string;
  displayName: string | null;
  role: 'admin' | 'user';
  tokenLimit: number | null; // per-user override (null = platform default)
  used: number;
  input: number;
  output: number;
  cached: number;
  requests: number;
  lastUsedAt: string | null;
  resetAt: string | null;
}

const clamp = (n: number) => Math.max(0, Math.trunc(n || 0));

/**
 * Records and aggregates per-user LLM token usage. Usage is always counted from the user's
 * `usage_reset_at` (NULL = all time), so an admin "reset" bumps that timestamp instead of deleting
 * rows. Plain class over the shared `bun:sqlite` Database, like the other repos.
 */
export class TokenUsageRepo {
  constructor(private readonly db: Database) {}

  record(input: TokenUsageInput): void {
    this.db
      .query(
        `INSERT INTO token_usage (id, user_id, tenant_id, session_id, model, input_tokens, output_tokens, total_tokens, cached_input_tokens, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        input.userId,
        input.tenantId ?? DEFAULT_TENANT_ID,
        input.sessionId ?? null,
        input.model ?? null,
        clamp(input.inputTokens),
        clamp(input.outputTokens),
        clamp(input.totalTokens),
        clamp(input.cachedInputTokens ?? 0),
        input.now ?? nowIso(),
      );
  }

  /** Usage for one user since `resetAt` (null → all time), broken down by input/output/cache. */
  usageForUser(userId: string, resetAt: string | null): UserUsage {
    const row = this.db
      .query<
        {
          used: number;
          input: number;
          output: number;
          cached: number;
          requests: number;
          last_used: string | null;
        },
        [string, string]
      >(
        `SELECT COALESCE(SUM(total_tokens), 0) AS used,
                COALESCE(SUM(input_tokens), 0) AS input,
                COALESCE(SUM(output_tokens), 0) AS output,
                COALESCE(SUM(cached_input_tokens), 0) AS cached,
                COUNT(*) AS requests, MAX(created_at) AS last_used
         FROM token_usage WHERE user_id = ? AND created_at >= ?`,
      )
      .get(userId, resetAt ?? '');
    return {
      used: row?.used ?? 0,
      input: row?.input ?? 0,
      output: row?.output ?? 0,
      cached: row?.cached ?? 0,
      requests: row?.requests ?? 0,
      lastUsedAt: row?.last_used ?? null,
    };
  }

  /** Total users (drives the admin `/usage` `total`, spec 056 FR-392). */
  countUsers(): number {
    const row = this.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM users').get();
    return row?.n ?? 0;
  }

  /**
   * Per-user overview for admins: every user with their tier, effective-limit override, and usage —
   * bounded + pageable (spec 056 FR-392), highest usage first.
   */
  summaryByUser(limit = 100, offset = 0): UserUsageRow[] {
    return this.db
      .query<
        {
          user_id: string;
          email: string;
          display_name: string | null;
          role: 'admin' | 'user';
          token_limit: number | null;
          reset_at: string | null;
          used: number;
          input: number;
          output: number;
          cached: number;
          requests: number;
          last_used: string | null;
        },
        [number, number]
      >(
        `SELECT u.id AS user_id, u.email, u.display_name, u.role, u.token_limit, u.usage_reset_at AS reset_at,
                COALESCE(SUM(t.total_tokens), 0) AS used,
                COALESCE(SUM(t.input_tokens), 0) AS input,
                COALESCE(SUM(t.output_tokens), 0) AS output,
                COALESCE(SUM(t.cached_input_tokens), 0) AS cached,
                COUNT(t.id) AS requests,
                MAX(t.created_at) AS last_used
         FROM users u
         LEFT JOIN token_usage t
           ON t.user_id = u.id AND t.created_at >= COALESCE(u.usage_reset_at, '')
         GROUP BY u.id
         ORDER BY used DESC, u.email ASC
         LIMIT ? OFFSET ?`,
      )
      .all(limit, offset)
      .map((r) => ({
        userId: r.user_id,
        email: r.email,
        displayName: r.display_name,
        role: r.role,
        tokenLimit: r.token_limit,
        used: r.used,
        input: r.input,
        output: r.output,
        cached: r.cached,
        requests: r.requests,
        lastUsedAt: r.last_used,
        resetAt: r.reset_at,
      }));
  }
}
