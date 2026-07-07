// Chat streaming client (T050). The event→callback dispatch is a pure function (unit-tested); the
// sendChat IO wrapper reads the SSE body via the tested decoder and forwards decoded events to it.

// The SSE event→payload contract is single-sourced from the API (spec 059 FR-423): each
// parseEventData<...> below is keyed off `ChatSSEEventMap`, so renaming an event/field there breaks
// this dispatch at compile time.
import type { ChatSSEEventMap } from '../../../explorer-api/src/chat/sse-events.ts';
import type { Citation, MapAnchor, ScopeDescriptor } from '../types.ts';
import { type SSEEvent, createSSEDecoder, parseEventData } from './sse.ts';

export interface ChatCallbacks {
  onSession?: (sessionId: string) => void;
  /** The server's generation id for this turn — used to re-attach (resume) or stop server-side. */
  onMessage?: (messageId: string) => void;
  onToken?: (delta: string) => void;
  onCitations?: (citations: Citation[]) => void;
  onAnchors?: (anchor: MapAnchor) => void;
  /** Live token usage for the turn (cumulative ↑input / ↓output / cached). */
  onUsage?: (usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
  }) => void;
  onError?: (message: string) => void;
  onDone?: () => void;
}

export interface ChatRequestBody {
  sessionId: string | null;
  message: string;
  scope: ScopeDescriptor;
  /** Datasets to ground the answer in (rows injected) without narrowing scope — e.g. the open reader. */
  groundingDatasetIds?: string[];
}

/** Route one decoded SSE event to the matching callback. Pure + exhaustively unit-tested. */
export function dispatchSSEEvent(ev: SSEEvent, cb: ChatCallbacks): void {
  switch (ev.event) {
    case 'session':
      cb.onSession?.(parseEventData<ChatSSEEventMap['session']>(ev).sessionId);
      return;
    case 'message':
      cb.onMessage?.(parseEventData<ChatSSEEventMap['message']>(ev).messageId);
      return;
    case 'token':
      cb.onToken?.(parseEventData<ChatSSEEventMap['token']>(ev).delta);
      return;
    // The server still emits a `tool` status event; with no tool-status UI it has no consumer, so it
    // falls through the switch harmlessly (spec 058 FR-414 — the server contract is untouched).
    case 'citations':
      cb.onCitations?.(parseEventData<ChatSSEEventMap['citations']>(ev).citations);
      return;
    case 'anchors':
      cb.onAnchors?.(parseEventData<ChatSSEEventMap['anchors']>(ev));
      return;
    case 'usage':
      cb.onUsage?.(parseEventData<ChatSSEEventMap['usage']>(ev));
      return;
    case 'error':
      cb.onError?.(parseEventData<ChatSSEEventMap['error']>(ev).message);
      return;
    case 'done':
      cb.onDone?.();
      return;
  }
}

export async function sendChat(
  body: ChatRequestBody,
  cb: ChatCallbacks,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetchImpl('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'include', // send the Kratos session cookie through Oathkeeper (gated route)
    ...(signal ? { signal } : {}),
  });
  // A non-OK response is a JSON error envelope, not an SSE stream — surface it.
  if (!res.ok) {
    const envelope = (await res.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    const msg =
      envelope?.error?.code === 'quota_exceeded'
        ? 'Достигнахте лимита си на токени за чата. Свържете се с администратор.'
        : (envelope?.error?.message ?? `request failed (${res.status})`);
    cb.onError?.(msg);
    return;
  }
  await readSSEStream(res, cb);
}

/** Re-attach to an in-flight (or just-finished) generation's stream (mid-stream resume). Replays
 * what's been produced so far, then continues live, ending with done/error. */
export async function resumeChat(
  messageId: string,
  cb: ChatCallbacks,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetchImpl(`/api/me/generations/${messageId}/stream`, {
    credentials: 'include',
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    // The generation is gone (server restart / evicted) — nothing to resume; not an error to surface.
    cb.onDone?.();
    return;
  }
  await readSSEStream(res, cb);
}

/** Read an SSE response body and dispatch each event to the callbacks. */
async function readSSEStream(res: Response, cb: ChatCallbacks): Promise<void> {
  if (!res.body) {
    cb.onError?.('no response stream');
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const sse = createSSEDecoder();
  let done = false;
  while (!done) {
    const chunk = await reader.read();
    done = chunk.done;
    if (chunk.value) {
      for (const ev of sse.push(decoder.decode(chunk.value, { stream: true }))) {
        dispatchSSEEvent(ev, cb);
      }
    }
  }
}
