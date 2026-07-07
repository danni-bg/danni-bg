// The chat SSE contract — the single shared definition of every server-sent event on /api/chat and
// the generation reconnect stream (spec 059, FR-423). The server serializes each event through
// `chatSSE(event, payload)` (payload type-checked against `ChatSSEEventMap`) and the SPA decodes it
// via `parseEventData<ChatSSEEventMap[...]>` in `dispatchSSEEvent`, so adding/renaming an event or a
// payload field breaks BOTH sides at compile time. This is a leaf module (imports only the zod-free
// view types from ./schemas via ../schemas.ts) so the web app can `import type` it without pulling any
// server runtime (bun:sqlite/node) into its type graph or Vite bundle.

import type { FreshnessBlock } from '../schemas.ts';

/** A dataset the grounded answer relied on: exists in the mirror and is within request scope. */
export interface Citation {
  datasetId: string;
  titleBg: string;
  sourceUrl: string;
  freshness: FreshnessBlock;
}

/** The cited datasets' geo, for the frontend to highlight/focus the map (FR-026/FR-027). */
export interface MapAnchor {
  geoEntityIds: string[];
  datasetIds: string[];
}

/** Live token usage for a turn, surfaced to the client for an ↑input / ↓output readout. */
export interface SSEUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

/**
 * Event name → payload type for the chat SSE stream. The server emits `session`+`message` from the
 * POST handler and the rest via the generation forwarder; `grounding` is debug-only (the SPA ignores
 * it). `done` carries an empty object (`{}`).
 */
export interface ChatSSEEventMap {
  session: { sessionId: string };
  message: { messageId: string };
  token: { delta: string };
  tool: { name: string; status: 'start' | 'done' };
  citations: { citations: Citation[] };
  anchors: MapAnchor;
  usage: SSEUsage;
  grounding: { text: string };
  error: { code?: string; message: string };
  done: Record<string, never>;
}

export type ChatSSEEventName = keyof ChatSSEEventMap;

/** Serialize a chat SSE event with a payload type-checked against the shared contract. */
export function chatSSE<E extends ChatSSEEventName>(
  event: E,
  data: ChatSSEEventMap[E],
): { event: E; data: string } {
  return { event, data: JSON.stringify(data) };
}
