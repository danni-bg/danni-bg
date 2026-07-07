// In-memory, session-scoped conversation store (T048). Conversations are held only for the active
// session and are NEVER persisted server-side (FR-019). Discarded when the process restarts.

// Import the shared payload types from the leaf SSE-events module (not grounding.ts, which pulls the
// server-only read-bridge) so this module stays free of runtime deps and the SPA can `import type` its
// message/session shapes without pulling bun:sqlite into its type graph (spec 059 FR-422).
import type { Citation, MapAnchor } from './sse-events.ts';

/** Tokens consumed by an assistant turn, kept with the message (shown after the reply). */
export interface MessageUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
  anchors?: MapAnchor;
  /** Assistant turns only: tokens consumed + wall-clock reply time (ms). */
  usage?: MessageUsage;
  durationMs?: number;
}

export interface Conversation {
  sessionId: string;
  messages: ChatMessage[];
  /**
   * Datasets the conversation is currently grounded on (sticky focus): an explicit "ask about this
   * dataset", else the datasets the last answer actually cited. Their rows are re-injected each turn
   * so follow-ups stay grounded instead of relying on the model recalling the previous answer's prose.
   */
  contextDatasetIds: string[];
}

/** One row of `GET /api/me/sessions` (the user's saved conversations, most-recent first). */
export interface SessionSummary {
  id: string;
  title: string | null;
  updatedAt: string;
}

/** `GET /api/me/sessions/:id` — a resumed conversation, plus a live-generation handle when one is
 * still streaming for it (re-attach via the generation stream). */
export interface ResumedSession extends Conversation {
  streaming?: { messageId: string };
}

/**
 * What the chat route needs from a conversation store, so the in-memory `SessionStore` (focused
 * tests) and the persistent `PersistentSessionStore` (real app) are interchangeable.
 */
export interface ConversationStore {
  getOrCreate(sessionId: string | null, userId: string, tenantId?: string): Conversation;
  append(sessionId: string, message: ChatMessage): void;
  setContext(sessionId: string, datasetIds: string[]): void;
}

/** Cap on sticky-context datasets (their rows are re-read every turn — keep it small). */
export const MAX_CONTEXT_DATASETS = 2;
/** History window replayed to the model: keep the most recent turns within a char budget. */
export const MAX_HISTORY_MESSAGES = 10;
export const MAX_HISTORY_CHARS = 24_000;

export class SessionStore implements ConversationStore {
  private readonly sessions = new Map<string, Conversation>();

  constructor(private readonly newId: () => string = () => crypto.randomUUID()) {}

  /** Return the existing conversation for `sessionId`, or create a fresh one (new id when null). The
   * `userId`/`tenantId` are part of the shared store interface but unused here (in-memory, single-process). */
  getOrCreate(sessionId: string | null, _userId?: string, _tenantId?: string): Conversation {
    if (sessionId !== null) {
      const existing = this.sessions.get(sessionId);
      if (existing) return existing;
    }
    const conv: Conversation = {
      sessionId: sessionId ?? this.newId(),
      messages: [],
      contextDatasetIds: [],
    };
    this.sessions.set(conv.sessionId, conv);
    return conv;
  }

  append(sessionId: string, message: ChatMessage): void {
    const conv = this.sessions.get(sessionId);
    if (conv) conv.messages.push(message);
  }

  /** Update the conversation's sticky grounding context (deduped, capped). */
  setContext(sessionId: string, datasetIds: string[]): void {
    const conv = this.sessions.get(sessionId);
    if (conv) conv.contextDatasetIds = [...new Set(datasetIds)].slice(0, MAX_CONTEXT_DATASETS);
  }

  get(sessionId: string): Conversation | undefined {
    return this.sessions.get(sessionId);
  }
}

/**
 * The tail of a transcript to replay: the most recent messages within a count + char budget, in
 * original order. Bounds the context window so a long conversation can't overflow the model (the
 * grounding rows live in the system prompt, not here). Always keeps at least the last message.
 */
export function windowMessages(
  messages: ChatMessage[],
  maxMessages: number = MAX_HISTORY_MESSAGES,
  maxChars: number = MAX_HISTORY_CHARS,
): ChatMessage[] {
  const out: ChatMessage[] = [];
  let chars = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    if (out.length >= maxMessages) break;
    if (out.length > 0 && chars + m.content.length > maxChars) break;
    out.push(m);
    chars += m.content.length;
  }
  return out.reverse();
}
