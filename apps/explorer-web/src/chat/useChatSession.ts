// Chat session lifecycle (spec 058). The transport layer below this (sse.ts → dispatchSSEEvent →
// sendChat/resumeChat) is preserved unchanged; this module owns everything above it that used to
// live inside ChatPanel: the message list, streaming flag, live token/usage meters, session id +
// localStorage persistence, the session-message → ChatMessage mapper, and the send/stop/new/open/
// delete/resume operations. The durable state machine is a framework-agnostic zustand/vanilla store
// (unit-tested without React, like explorerStore); `useChatSession` is the thin React wrapper that
// binds it to the explorer store (scope, region selection) and adds the live elapsed-time meter.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { type StoreApi, createStore } from 'zustand/vanilla';
import {
  type ResumedSession,
  type SessionMessage,
  type SessionSummary,
  deleteSession,
  getSession,
  listSessions,
  stopGeneration,
} from '../lib/meApi.ts';
import { filterStateToScope } from '../lib/scope.ts';
import { explorerStore } from '../store/explorerStore.ts';
import type { Citation, MapAnchor, ScopeDescriptor } from '../types.ts';
import { type ChatCallbacks, resumeChat, sendChat } from './sendChat.ts';

const SESSION_KEY = 'danni.chat.session';
const EMPTY_ANCHOR: MapAnchor = { geoEntityIds: [], datasetIds: [] };

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
  /** Assistant turns: tokens consumed + reply duration (ms), shown after the reply + kept on reload. */
  usage?: TurnUsage;
  durationMs?: number;
}

/** Injectable streaming transport — the tested `sendChat`/`resumeChat` wrappers in production. */
export interface ChatTransport {
  sendChat: typeof sendChat;
  resumeChat: typeof resumeChat;
}

/** Injectable session REST client — `../lib/meApi.ts` in production. */
export interface SessionApi {
  listSessions: () => Promise<SessionSummary[]>;
  getSession: (id: string) => Promise<ResumedSession>;
  deleteSession: (id: string) => Promise<void>;
  stopGeneration: (messageId: string) => Promise<void>;
}

/** The minimal storage surface used for cross-reload session persistence (localStorage, or null). */
export interface SessionStorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

/** Side effects into the explorer store — kept injectable so the state machine stays testable. */
export interface ChatSessionEffects {
  /** Re-select the map regions an assistant turn grounded on (chips + list + next-turn scope). */
  selectRegions: (entityIds: string[]) => void;
  /** Clear the "ask about this dataset" focus (new chat / opening another conversation). */
  clearFocus: () => void;
  /** Clear the map highlight anchor (new chat). */
  clearHighlight: () => void;
}

export interface ChatSessionDeps {
  transport: ChatTransport;
  api: SessionApi;
  storage: SessionStorageLike | null;
  effects: ChatSessionEffects;
}

export interface ChatSessionState {
  sessionId: string | null;
  messages: ChatMessage[];
  streaming: boolean;
  /** Streamed-delta counter — smooth ↓output between server `usage` events (live meter). */
  genTokens: number;
  usage: TurnUsage | null;
  error: string | null;
  sessions: SessionSummary[];
  /** Send a new turn; `scope`/`groundingDatasetIds` are computed by the caller from live filters. */
  send: (
    question: string,
    opts: { scope: ScopeDescriptor; groundingDatasetIds?: string[] },
  ) => Promise<void>;
  /** Stop the in-flight turn locally AND server-side (a user-initiated stop, not an error). */
  stop: () => void;
  /** Detach from the in-flight stream locally without stopping it server-side (e.g. unmount). */
  detach: () => void;
  newChat: () => void;
  openSession: (id: string) => Promise<void>;
  removeSession: (id: string) => Promise<void>;
  /** Mount-time restore: load the session list + the last open conversation, re-attaching if live. */
  restore: () => Promise<void>;
}

/** The regions the latest assistant turn grounded on — re-selected on restore/open (FR-107). */
export function lastGroundedRegions(messages: { role: string; anchors?: MapAnchor }[]): string[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'assistant' && m.anchors && m.anchors.geoEntityIds.length > 0) {
      return m.anchors.geoEntityIds;
    }
  }
  return [];
}

/**
 * Build the framework-agnostic session state machine. All IO is injected (`deps`) so send, resume,
 * abort-during-resume, network-failure-during-resume, and the new/open/delete transitions are
 * unit-testable with `bun:test` — exactly like the transport layer beneath it.
 */
export function createChatSessionStore(deps: ChatSessionDeps): StoreApi<ChatSessionState> {
  const { transport, api, storage, effects } = deps;

  // Non-reactive turn bookkeeping (no render depends on these directly).
  let idCounter = 0;
  const nextId = () => ++idCounter;
  let activeController: AbortController | null = null;
  let generationId: string | null = null; // server generation id of the in-flight turn

  const persist = (id: string | null) => {
    if (!storage) return;
    if (id) storage.setItem(SESSION_KEY, id);
    else storage.removeItem(SESSION_KEY);
  };

  // The single session-message → ChatMessage mapper (FR-411: exactly one copy).
  const mapMessages = (messages: SessionMessage[]): ChatMessage[] =>
    messages.map((m) => ({
      id: nextId(),
      role: m.role,
      content: m.content,
      ...(m.citations ? { citations: m.citations } : {}),
      ...(m.usage ? { usage: m.usage } : {}),
      ...(m.durationMs != null ? { durationMs: m.durationMs } : {}),
    }));

  return createStore<ChatSessionState>((set, get) => {
    const setSession = (id: string | null) => {
      persist(id);
      set({ sessionId: id });
    };

    const refreshSessions = () => {
      api
        .listSessions()
        .then((sessions) => set({ sessions }))
        .catch(() => {});
    };

    const patchAssistant = (aid: number, content: string, citations?: Citation[]) =>
      set((s) => ({
        messages: s.messages.map((m) =>
          m.id === aid ? { ...m, content, ...(citations ? { citations } : {}) } : m,
        ),
      }));

    /**
     * The single attach-stream lifecycle (FR-411) for the trailing assistant bubble `aid`, shared by
     * `send`, `openSession`, and mount `restore`. `measureDuration` stamps a from-start reply time on
     * completion — false for resumed turns, which omit `durationMs` rather than record a bogus
     * from-re-attach value (FR-413). The whole run is wrapped in try/catch (FR-412): an aborted
     * reader (stop / new chat / switch / unmount) resolves quietly, a genuine fetch/read failure
     * surfaces the same `'мрежова грешка'` affordance as a failed send. The `activeController` guard
     * keeps a stale stream from clobbering a newer one's state.
     */
    const attachStream = async (
      aid: number,
      run: (cb: ChatCallbacks, signal: AbortSignal) => Promise<void>,
      measureDuration: boolean,
    ): Promise<void> => {
      const controller = new AbortController();
      activeController = controller;
      set({ streaming: true, genTokens: 0, usage: null, error: null });
      const startAt = Date.now();
      let assistant = '';
      let cites: Citation[] = [];
      let finalUsage: TurnUsage | null = null;
      try {
        await run(
          {
            onSession: (id) => setSession(id),
            onMessage: (id) => {
              generationId = id;
            },
            onToken: (delta) => {
              assistant += delta;
              set((s) => ({ genTokens: s.genTokens + 1 }));
              patchAssistant(aid, assistant, cites.length > 0 ? cites : undefined);
            },
            onCitations: (citations) => {
              cites = citations;
              patchAssistant(aid, assistant, cites);
            },
            onUsage: (u) => {
              finalUsage = u;
              set({ usage: u });
            },
            onAnchors: (anchor) => {
              if (anchor.geoEntityIds.length > 0) effects.selectRegions(anchor.geoEntityIds);
            },
            onError: (message) => set({ error: message }),
            onDone: () => {
              if (activeController !== controller) return;
              const durationMs = measureDuration ? Date.now() - startAt : null;
              set((s) => ({
                streaming: false,
                messages: s.messages.map((m) =>
                  m.id === aid
                    ? {
                        ...m,
                        ...(finalUsage ? { usage: finalUsage } : {}),
                        ...(durationMs != null ? { durationMs } : {}),
                      }
                    : m,
                ),
              }));
              refreshSessions();
            },
          },
          controller.signal,
        );
      } catch {
        // A user-initiated abort (stop / new chat / switch / unmount) is expected, not an error.
        if (!controller.signal.aborted) set({ error: 'мрежова грешка' });
      } finally {
        if (activeController === controller) {
          activeController = null;
          set({ streaming: false });
        }
      }
    };

    const resumeInto = (loaded: ChatMessage[], streamingMessageId: string) => {
      const aid = nextId();
      set({ messages: [...loaded, { id: aid, role: 'assistant', content: '' }] });
      generationId = streamingMessageId;
      return attachStream(
        aid,
        (cb, signal) => transport.resumeChat(streamingMessageId, cb, undefined, signal),
        false,
      );
    };

    return {
      sessionId: null,
      messages: [],
      streaming: false,
      genTokens: 0,
      usage: null,
      error: null,
      sessions: [],

      async send(question, { scope, groundingDatasetIds }) {
        const q = question.trim();
        if (!q || get().streaming) return;
        const userId = nextId();
        const assistantId = nextId();
        set((s) => ({
          messages: [
            ...s.messages,
            { id: userId, role: 'user', content: q },
            { id: assistantId, role: 'assistant', content: '' },
          ],
        }));
        const sessionId = get().sessionId;
        await attachStream(
          assistantId,
          (cb, signal) =>
            transport.sendChat(
              {
                sessionId,
                message: q,
                scope,
                ...(groundingDatasetIds && groundingDatasetIds.length > 0
                  ? { groundingDatasetIds }
                  : {}),
              },
              cb,
              undefined,
              signal,
            ),
          true,
        );
      },

      stop() {
        activeController?.abort();
        if (generationId) void api.stopGeneration(generationId);
        set({ streaming: false });
      },

      detach() {
        activeController?.abort();
        activeController = null;
        set({ streaming: false });
      },

      newChat() {
        activeController?.abort();
        activeController = null;
        generationId = null;
        setSession(null);
        set({ streaming: false, messages: [], error: null, usage: null, genTokens: 0 });
        effects.clearFocus();
        effects.clearHighlight();
        effects.selectRegions([]);
      },

      async openSession(id) {
        activeController?.abort();
        set({ streaming: false });
        try {
          const conv = await api.getSession(id);
          setSession(conv.sessionId);
          effects.clearFocus();
          // Re-select the regions this conversation last grounded on (FR-107).
          effects.selectRegions(lastGroundedRegions(conv.messages));
          const loaded = mapMessages(conv.messages);
          if (conv.streaming) {
            await resumeInto(loaded, conv.streaming.messageId);
          } else {
            set({ messages: loaded, error: null });
          }
        } catch {
          set({ error: 'Неуспешно зареждане на разговора.' });
        }
      },

      async removeSession(id) {
        try {
          await api.deleteSession(id);
          set((s) => ({ sessions: s.sessions.filter((x) => x.id !== id) }));
          if (id === get().sessionId) get().newChat();
        } catch {
          set({ error: 'Неуспешно изтриване на разговора.' });
        }
      },

      async restore() {
        refreshSessions();
        const stored = storage?.getItem(SESSION_KEY) ?? null;
        if (!stored) return;
        try {
          const conv = await api.getSession(stored);
          setSession(conv.sessionId);
          effects.selectRegions(lastGroundedRegions(conv.messages));
          const loaded = mapMessages(conv.messages);
          if (conv.streaming) {
            await resumeInto(loaded, conv.streaming.messageId);
          } else {
            set({ messages: loaded });
          }
        } catch {
          // The stored session is gone (deleted / evicted) — forget it.
          persist(null);
        }
      },
    };
  });
}

/** Production dependencies: the real transport, `meApi` REST client, localStorage, explorer store. */
function defaultDeps(): ChatSessionDeps {
  return {
    transport: { sendChat, resumeChat },
    api: { listSessions, getSession, deleteSession, stopGeneration },
    storage: typeof localStorage !== 'undefined' ? localStorage : null,
    effects: {
      selectRegions: (ids) => explorerStore.getState().selectRegions(ids),
      clearFocus: () => explorerStore.getState().setChatFocus(null),
      clearHighlight: () => explorerStore.getState().setHighlight(EMPTY_ANCHOR),
    },
  };
}

export interface UseChatSession {
  sessionId: string | null;
  messages: ChatMessage[];
  streaming: boolean;
  genTokens: number;
  usage: TurnUsage | null;
  error: string | null;
  sessions: SessionSummary[];
  /** Live-ticking elapsed time (ms) for the in-flight turn — the ⏱ clock in the streaming footer. */
  elapsedMs: number;
  send: (question: string) => Promise<void>;
  stop: () => void;
  newChat: () => void;
  openSession: (id: string) => Promise<void>;
  removeSession: (id: string) => Promise<void>;
}

/**
 * React binding for the session state machine. Owns the store instance, computes the send-time scope
 * from the live explorer filters (so `ChatPanel` never touches transport/scope/storage), restores the
 * last conversation once the user is present, and adds the live elapsed-time meter. `deps` is
 * overridable for tests, but production callers pass nothing.
 */
export function useChatSession(
  { enabled }: { enabled: boolean },
  deps?: ChatSessionDeps,
): UseChatSession {
  const store = useMemo(() => createChatSessionStore(deps ?? defaultDeps()), [deps]);

  const sessionId = useStore(store, (s) => s.sessionId);
  const messages = useStore(store, (s) => s.messages);
  const streaming = useStore(store, (s) => s.streaming);
  const genTokens = useStore(store, (s) => s.genTokens);
  const usage = useStore(store, (s) => s.usage);
  const error = useStore(store, (s) => s.error);
  const sessions = useStore(store, (s) => s.sessions);

  // Live-ticking elapsed clock: resets each turn, stops when streaming ends.
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (!streaming) return;
    const start = Date.now();
    setElapsedMs(0);
    const id = setInterval(() => setElapsedMs(Date.now() - start), 100);
    return () => clearInterval(id);
  }, [streaming]);

  // On sign-in: restore the last conversation (re-attaching to a live generation via `attachStream`).
  // On unmount / sign-out: detach the reader locally (must not throw — FR-412), leaving the server
  // generation running so it can be re-attached later.
  useEffect(() => {
    if (!enabled) return;
    void store.getState().restore();
    return () => {
      store.getState().detach();
    };
  }, [enabled, store]);

  const send = useCallback(
    (question: string) => {
      const { filters, chatFocus, reader } = explorerStore.getState();
      const scope: ScopeDescriptor = {
        ...filterStateToScope(filters),
        ...(chatFocus ? { datasetIds: [chatFocus.datasetId] } : {}),
      };
      return store.getState().send(question, {
        scope,
        ...(reader ? { groundingDatasetIds: [reader.datasetId] } : {}),
      });
    },
    [store],
  );

  const stop = useCallback(() => store.getState().stop(), [store]);
  const newChat = useCallback(() => store.getState().newChat(), [store]);
  const openSession = useCallback((id: string) => store.getState().openSession(id), [store]);
  const removeSession = useCallback((id: string) => store.getState().removeSession(id), [store]);

  return {
    sessionId,
    messages,
    streaming,
    genTokens,
    usage,
    error,
    sessions,
    elapsedMs,
    send,
    stop,
    newChat,
    openSession,
    removeSession,
  };
}
