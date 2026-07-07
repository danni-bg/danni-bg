// Persistent, per-user conversation store (resumable chat history). Backs the chat route like the
// in-memory SessionStore, but writes each question + reply to SQLite so conversations survive reloads
// and restarts and can be reopened. Lives under chat/ (not src/store/repos) because it deals in the
// chat-specific Citation/MapAnchor types.

import type { Database } from 'bun:sqlite';
import { nowIso } from '../../../../src/lib/time.ts';
import { DEFAULT_TENANT_ID } from '../../../../src/store/repos/tenants.ts';
import type { Citation, MapAnchor } from './grounding.ts';
import type {
  ChatMessage,
  Conversation,
  ConversationStore,
  MessageUsage,
  SessionSummary,
} from './session.ts';
// Single source of the sessions-route response shapes lives in ./session.ts (shared with the SPA —
// spec 059 FR-422); re-exported so existing `from './sessions-repo.ts'` imports keep working.
export type { SessionSummary } from './session.ts';

const TITLE_MAX = 80;

interface SessionRow {
  id: string;
  user_id: string;
  title: string | null;
  context_dataset_ids: string;
  updated_at: string;
}
interface MessageRow {
  role: 'user' | 'assistant';
  content: string;
  citations_json: string | null;
  anchors_json: string | null;
  usage_json: string | null;
  duration_ms: number | null;
}

function parse<T>(json: string | null): T | undefined {
  if (json == null) return undefined;
  try {
    return JSON.parse(json) as T;
  } catch {
    return undefined;
  }
}

export class PersistentSessionStore implements ConversationStore {
  constructor(private readonly db: Database) {}

  private messages(sessionId: string): ChatMessage[] {
    return this.db
      .query<MessageRow, [string]>(
        'SELECT role, content, citations_json, anchors_json, usage_json, duration_ms FROM chat_messages WHERE session_id = ? ORDER BY created_at',
      )
      .all(sessionId)
      .map((m) => {
        const citations = parse<Citation[]>(m.citations_json);
        const anchors = parse<MapAnchor>(m.anchors_json);
        const usage = parse<MessageUsage>(m.usage_json);
        return {
          role: m.role,
          content: m.content,
          ...(citations ? { citations } : {}),
          ...(anchors ? { anchors } : {}),
          ...(usage ? { usage } : {}),
          ...(m.duration_ms != null ? { durationMs: m.duration_ms } : {}),
        };
      });
  }

  private toConversation(row: SessionRow): Conversation {
    return {
      sessionId: row.id,
      messages: this.messages(row.id),
      contextDatasetIds: parse<string[]>(row.context_dataset_ids) ?? [],
    };
  }

  /**
   * Resume the user's session if `sessionId` is theirs; otherwise start a fresh owned session, tagged
   * with the caller's active tenant (spec 029). User-ownership already isolates reads; the tenant_id
   * makes a session attributable to its org for the tenant boundary.
   */
  getOrCreate(
    sessionId: string | null,
    userId: string,
    tenantId = DEFAULT_TENANT_ID,
  ): Conversation {
    if (sessionId) {
      const row = this.db
        .query<SessionRow, [string, string]>(
          'SELECT * FROM chat_sessions WHERE id = ? AND user_id = ?',
        )
        .get(sessionId, userId);
      if (row) return this.toConversation(row);
    }
    const id = crypto.randomUUID();
    const now = nowIso();
    this.db
      .query(
        'INSERT INTO chat_sessions (id, user_id, tenant_id, title, context_dataset_ids, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?)',
      )
      .run(id, userId, tenantId, '[]', now, now);
    return { sessionId: id, messages: [], contextDatasetIds: [] };
  }

  append(sessionId: string, message: ChatMessage): void {
    const now = nowIso();
    this.db
      .query(
        'INSERT INTO chat_messages (id, session_id, role, content, citations_json, anchors_json, usage_json, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        crypto.randomUUID(),
        sessionId,
        message.role,
        message.content,
        message.citations ? JSON.stringify(message.citations) : null,
        message.anchors ? JSON.stringify(message.anchors) : null,
        message.usage ? JSON.stringify(message.usage) : null,
        message.durationMs ?? null,
        now,
      );
    // Title the session from its first user message (COALESCE keeps an existing one); bump recency.
    const title = message.role === 'user' ? message.content.trim().slice(0, TITLE_MAX) : null;
    this.db
      .query('UPDATE chat_sessions SET title = COALESCE(title, ?), updated_at = ? WHERE id = ?')
      .run(title, now, sessionId);
  }

  setContext(sessionId: string, datasetIds: string[]): void {
    this.db
      .query('UPDATE chat_sessions SET context_dataset_ids = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(datasetIds), nowIso(), sessionId);
  }

  /** Recent conversations for the user, newest first. */
  listForUser(userId: string, limit = 100): SessionSummary[] {
    return this.db
      .query<{ id: string; title: string | null; updated_at: string }, [string, number]>(
        'SELECT id, title, updated_at FROM chat_sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?',
      )
      .all(userId, limit)
      .map((r) => ({ id: r.id, title: r.title, updatedAt: r.updated_at }));
  }

  /** Full conversation (with citations/anchors) if it belongs to the user, else null. */
  getForUser(sessionId: string, userId: string): Conversation | null {
    const row = this.db
      .query<SessionRow, [string, string]>(
        'SELECT * FROM chat_sessions WHERE id = ? AND user_id = ?',
      )
      .get(sessionId, userId);
    return row ? this.toConversation(row) : null;
  }

  /** Delete a conversation (+ its messages) if it belongs to the user. Returns true if removed. */
  deleteForUser(sessionId: string, userId: string): boolean {
    const row = this.db
      .query<{ id: string }, [string, string]>(
        'SELECT id FROM chat_sessions WHERE id = ? AND user_id = ?',
      )
      .get(sessionId, userId);
    if (!row) return false;
    this.db.query('DELETE FROM chat_messages WHERE session_id = ?').run(sessionId);
    this.db.query('DELETE FROM chat_sessions WHERE id = ?').run(sessionId);
    return true;
  }
}
