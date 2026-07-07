import { ArrowUp, ChevronDown, ChevronRight, Plus, Square, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import { Link } from 'react-router-dom';
import remarkGfm from 'remark-gfm';
import { useAuth } from '../auth/AuthContext.tsx';
import { completePartialMarkdown } from '../lib/markdown.ts';
import {
  type SessionSummary,
  deleteSession,
  getSession,
  listSessions,
  stopGeneration,
} from '../lib/meApi.ts';
import { filterStateToScope } from '../lib/scope.ts';
import { useExplorer } from '../store/explorerStore.ts';
import type { Citation, MapAnchor } from '../types.ts';
import { type ChatCallbacks, resumeChat, sendChat } from './sendChat.ts';

const SESSION_KEY = 'danni.chat.session';

// Styled hover tooltip (appears above the button); shown via group-hover so it matches the theme.
const TOOLTIP =
  'pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 whitespace-nowrap rounded-md bg-popover px-2 py-1 text-xs text-popover-foreground opacity-0 shadow-md ring-1 ring-border transition-opacity group-hover:opacity-100';

interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
  /** Assistant turns: tokens consumed + reply duration (ms), shown after the reply + kept on reload. */
  usage?: TurnUsage;
  durationMs?: number;
}

interface ChatPanelProps {
  onSelectDataset: (datasetId: string) => void;
}

const SUGGESTIONS = [
  'Какви данни има за качеството на въздуха?',
  'Сравни ПТП с фатален край по години',
  'Кои набори са за бюджета на общините?',
];

/** Claude-style "thinking" indicator: three dots breathing out of phase (keyframe in index.css). */
function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1 py-1" aria-label="Асистентът подготвя отговор">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-2 w-2 rounded-full bg-primary/70"
          style={{
            animation: 'danni-typing 1.25s ease-in-out infinite',
            animationDelay: `${i * 0.18}s`,
          }}
        />
      ))}
    </span>
  );
}

/** Tokens (↑input / ↓output / cached) + reply time, in one styling — used both LIVE (streaming
 * bubble, with a pulsing dot + ticking clock) and after completion (persisted on the message). */
function UsageFooter({
  usage,
  durationMs,
  live,
}: {
  usage: TurnUsage | null;
  durationMs: number | null;
  live?: boolean;
}) {
  if (!usage && durationMs == null) return null;
  const fmt = (n: number) => n.toLocaleString('bg-BG');
  return (
    <div
      className="flex items-center gap-3 text-[11px] text-muted-foreground tabular-nums"
      {...(live ? { 'aria-live': 'polite' as const } : {})}
      title="Токени (↑ вход, ↓ изход) и време за отговор"
    >
      {usage && (
        <span className="inline-flex items-center gap-1">
          {live && (
            <span className="inline-block size-1.5 animate-pulse rounded-full bg-orange-500" />
          )}
          ↑ {fmt(usage.inputTokens)} · ↓ {fmt(usage.outputTokens)}
          {usage.cachedInputTokens ? ` · ⚡ ${fmt(usage.cachedInputTokens)}` : ''} ток.
        </span>
      )}
      {durationMs != null && <span>⏱ {(durationMs / 1000).toFixed(1)} с</span>}
    </div>
  );
}

/** The regions an assistant turn grounded on — the latest such set, so resume re-selects them. */
function lastGroundedRegions(messages: { role: string; anchors?: MapAnchor }[]): string[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'assistant' && m.anchors && m.anchors.geoEntityIds.length > 0) {
      return m.anchors.geoEntityIds;
    }
  }
  return [];
}

export function ChatPanel({ onSelectDataset }: ChatPanelProps) {
  const filters = useExplorer((s) => s.filters);
  const setHighlight = useExplorer((s) => s.setHighlight);
  // Chat-grounded regions become the map selection (filters.geoUnitIds) — so they show as selector
  // chips, scope the dataset list, and scope the next turn, exactly as if picked on the map.
  const selectRegions = useExplorer((s) => s.selectRegions);
  const chatFocus = useExplorer((s) => s.chatFocus);
  const setChatFocus = useExplorer((s) => s.setChatFocus);
  const reader = useExplorer((s) => s.reader);
  const { user } = useAuth();

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  // Live token meter: genTokens counts streamed deltas (smooth ↓ output between usage events); usage
  // holds the server-reported cumulative totals (↑ input + exact ↓ output + cached).
  const [genTokens, setGenTokens] = useState(0);
  const [usage, setUsage] = useState<{
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Live-ticking elapsed time for the in-flight turn (the ⏱ clock in the streaming footer).
  const [elapsedMs, setElapsedMs] = useState(0);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const idRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const msgIdRef = useRef<string | null>(null); // server generation id of the in-flight turn
  const scrollRef = useRef<HTMLDivElement>(null);

  // When a dataset focus is set ("ask about this dataset"), prefill a question about it.
  useEffect(() => {
    if (chatFocus) setInput(`Какво съдържа наборът „${chatFocus.titleBg}"?`);
  }, [chatFocus]);

  // Tick the elapsed-time clock while a turn streams; resets each turn, stops when it ends.
  useEffect(() => {
    if (!streaming) return;
    const start = Date.now();
    setElapsedMs(0);
    const id = setInterval(() => setElapsedMs(Date.now() - start), 100);
    return () => clearInterval(id);
  }, [streaming]);

  // On sign-in: load the conversation list and restore the last open conversation (persisted id).
  useEffect(() => {
    if (!user) return;
    let active = true;
    listSessions()
      .then((s) => active && setSessions(s))
      .catch(() => {});
    const stored = localStorage.getItem(SESSION_KEY);
    if (stored) {
      getSession(stored)
        .then((conv) => {
          if (!active) return;
          setSessionId(conv.sessionId);
          // Re-select the regions the conversation last grounded on, so the map + scope match it.
          selectRegions(lastGroundedRegions(conv.messages));
          const loaded = conv.messages.map((m) => ({
            id: ++idRef.current,
            role: m.role,
            content: m.content,
            ...(m.citations ? { citations: m.citations } : {}),
            ...(m.usage ? { usage: m.usage } : {}),
            ...(m.durationMs != null ? { durationMs: m.durationMs } : {}),
          }));
          // If a generation was still running when we reloaded, re-attach to its live stream
          // (mid-stream resume) — append a live assistant bubble and stream into it.
          if (conv.streaming) {
            const aid = ++idRef.current;
            setMessages([...loaded, { id: aid, role: 'assistant', content: '' }]);
            msgIdRef.current = conv.streaming.messageId;
            setStreaming(true);
            const controller = new AbortController();
            abortRef.current = controller;
            const startAt = Date.now();
            let text = '';
            let cites: Citation[] = [];
            let finalUsage: TurnUsage | null = null;
            const patch = () =>
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === aid
                    ? { ...m, content: text, ...(cites.length ? { citations: cites } : {}) }
                    : m,
                ),
              );
            setGenTokens(0);
            setUsage(null);
            void resumeChat(
              conv.streaming.messageId,
              {
                onToken: (d) => {
                  text += d;
                  setGenTokens((n) => n + 1);
                  patch();
                },
                onCitations: (c) => {
                  cites = c;
                  patch();
                },
                onUsage: (u) => {
                  finalUsage = u;
                  setUsage(u);
                },
                onAnchors: (a) => {
                  if (a.geoEntityIds.length > 0) selectRegions(a.geoEntityIds);
                },
                onError: setError,
                onDone: () => {
                  setStreaming(false);
                  const dur = Date.now() - startAt;
                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === aid
                        ? { ...m, ...(finalUsage ? { usage: finalUsage } : {}), durationMs: dur }
                        : m,
                    ),
                  );
                  listSessions()
                    .then(setSessions)
                    .catch(() => {});
                },
              },
              undefined,
              controller.signal,
            ).finally(() => setStreaming(false));
          } else {
            setMessages(loaded);
          }
        })
        .catch(() => localStorage.removeItem(SESSION_KEY));
    }
    return () => {
      active = false;
    };
  }, [user]);

  // Remember the open conversation across reloads.
  useEffect(() => {
    if (!user) return;
    if (sessionId) localStorage.setItem(SESSION_KEY, sessionId);
    else localStorage.removeItem(SESSION_KEY);
  }, [sessionId, user]);

  // Keep the latest message in view as the answer streams.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  function patchAssistant(content: string, citations?: Citation[]) {
    setMessages((prev) => {
      const copy = [...prev];
      const last = copy[copy.length - 1];
      if (last && last.role === 'assistant') {
        copy[copy.length - 1] = { ...last, content, ...(citations ? { citations } : {}) };
      }
      return copy;
    });
  }

  /** Attach token usage + reply duration to the finished assistant turn (the trailing bubble). */
  function stampLastAssistant(usage: TurnUsage | null, durationMs: number) {
    setMessages((prev) => {
      const copy = [...prev];
      const last = copy[copy.length - 1];
      if (last && last.role === 'assistant') {
        copy[copy.length - 1] = { ...last, ...(usage ? { usage } : {}), durationMs };
      }
      return copy;
    });
  }

  /** Stream into the trailing assistant bubble, whether starting a turn (sendChat) or re-attaching to
   * an in-flight one (resumeChat). Shared callbacks + lifecycle. */
  async function attachStream(run: (cb: ChatCallbacks, signal: AbortSignal) => Promise<void>) {
    const controller = new AbortController();
    abortRef.current = controller;
    setStreaming(true);
    setGenTokens(0);
    setUsage(null);
    setError(null);
    const startAt = Date.now();
    let assistant = '';
    let cites: Citation[] = [];
    let finalUsage: TurnUsage | null = null;
    try {
      await run(
        {
          onSession: setSessionId,
          onMessage: (id) => {
            msgIdRef.current = id;
          },
          onToken: (delta) => {
            assistant += delta;
            setGenTokens((n) => n + 1);
            patchAssistant(assistant, cites.length > 0 ? cites : undefined);
          },
          onCitations: (citations) => {
            cites = citations;
            patchAssistant(assistant, cites);
          },
          onUsage: (u) => {
            finalUsage = u;
            setUsage(u);
          },
          onAnchors: (anchor) => {
            if (anchor.geoEntityIds.length > 0) selectRegions(anchor.geoEntityIds);
          },
          onError: (message) => setError(message),
          onDone: () => {
            setStreaming(false);
            // Stamp the finished turn with its token usage + reply duration (kept in the bubble).
            stampLastAssistant(finalUsage, Date.now() - startAt);
            listSessions()
              .then(setSessions)
              .catch(() => {});
          },
        },
        controller.signal,
      );
    } catch {
      // A user-initiated stop aborts the fetch; that's not an error.
      if (!controller.signal.aborted) setError('мрежова грешка');
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  async function send(text?: string) {
    const question = (text ?? input).trim();
    if (!question || streaming) return;
    setInput('');
    setMessages((prev) => [
      ...prev,
      { id: ++idRef.current, role: 'user', content: question },
      { id: ++idRef.current, role: 'assistant', content: '' },
    ]);
    // Auto-focus the dataset open in the reader: ground the answer in its rows without narrowing
    // scope. A deliberate chatFocus (scope.datasetIds) takes precedence on the backend.
    const scope = {
      ...filterStateToScope(filters),
      ...(chatFocus ? { datasetIds: [chatFocus.datasetId] } : {}),
    };
    await attachStream((cb, signal) =>
      sendChat(
        {
          sessionId,
          message: question,
          scope,
          ...(reader ? { groundingDatasetIds: [reader.datasetId] } : {}),
        },
        cb,
        undefined,
        signal,
      ),
    );
  }

  function stop() {
    abortRef.current?.abort(); // stop reading locally
    if (msgIdRef.current) void stopGeneration(msgIdRef.current); // and stop it server-side
    setStreaming(false);
  }

  /** Start a fresh conversation: drop the server session + transcript and clear chat-driven state. */
  function newChat() {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
    setMessages([]);
    setSessionId(null);
    setError(null);
    setInput('');
    setChatFocus(null);
    setHighlight({ geoEntityIds: [], datasetIds: [] });
    selectRegions([]); // a fresh conversation starts with no region selection/scope
  }

  /** Open a saved conversation and load its transcript; re-attach if it's still generating. */
  async function openSession(id: string) {
    abortRef.current?.abort();
    setStreaming(false);
    try {
      const conv = await getSession(id);
      setSessionId(conv.sessionId);
      setChatFocus(null);
      setHistoryOpen(false);
      // Re-select the regions this conversation last grounded on (FR-107) — chips, list, and the
      // next turn's scope all reflect the reopened conversation.
      selectRegions(lastGroundedRegions(conv.messages));
      const loaded = conv.messages.map((m) => ({
        id: ++idRef.current,
        role: m.role,
        content: m.content,
        ...(m.citations ? { citations: m.citations } : {}),
        ...(m.usage ? { usage: m.usage } : {}),
        ...(m.durationMs != null ? { durationMs: m.durationMs } : {}),
      }));
      if (conv.streaming) {
        setMessages([...loaded, { id: ++idRef.current, role: 'assistant', content: '' }]);
        msgIdRef.current = conv.streaming.messageId;
        const mid = conv.streaming.messageId;
        await attachStream((cb, signal) => resumeChat(mid, cb, undefined, signal));
      } else {
        setMessages(loaded);
        setError(null);
      }
    } catch {
      setError('Неуспешно зареждане на разговора.');
    }
  }

  async function removeSession(id: string) {
    try {
      await deleteSession(id);
      setSessions((prev) => prev.filter((x) => x.id !== id));
      if (id === sessionId) newChat();
    } catch {
      setError('Неуспешно изтриване на разговора.');
    }
  }

  const empty = messages.length === 0;

  return (
    <section className="relative flex h-full flex-col gap-3">
      {/* When signed out, the whole chat is blurred + non-interactive behind a centered prompt. */}
      <div
        className={
          user
            ? 'flex h-full min-h-0 flex-col gap-3'
            : 'pointer-events-none flex h-full min-h-0 select-none flex-col gap-3 blur-sm'
        }
      >
        {/* Resumable history: a collapsible list of the user's past conversations. */}
        <div className="rounded-lg border border-border">
          <button
            type="button"
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((o) => !o)}
            className="flex w-full items-center justify-between px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground transition hover:text-foreground"
          >
            <span className="flex items-center gap-1">
              {historyOpen ? (
                <ChevronDown className="size-3.5" />
              ) : (
                <ChevronRight className="size-3.5" />
              )}
              Разговори
            </span>
            {sessions.length > 0 ? <span>{sessions.length}</span> : null}
          </button>
          {historyOpen ? (
            <div className="max-h-44 overflow-y-auto border-border border-t">
              {sessions.length === 0 ? (
                <p className="px-3 py-2 text-xs text-muted-foreground">Няма запазени разговори.</p>
              ) : (
                sessions.map((s) => (
                  <div key={s.id} className="group flex items-center gap-1 px-2 hover:bg-accent">
                    <button
                      type="button"
                      onClick={() => void openSession(s.id)}
                      className={`flex-1 truncate py-1.5 text-left text-sm ${s.id === sessionId ? 'font-medium text-primary' : ''}`}
                    >
                      {s.title || 'Нов разговор'}
                    </button>
                    <button
                      type="button"
                      aria-label="Изтрий разговора"
                      onClick={() => void removeSession(s.id)}
                      className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition hover:text-destructive group-hover:opacity-100"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                ))
              )}
            </div>
          ) : null}
        </div>
        <div ref={scrollRef} aria-label="Разговор" className="flex-1 space-y-4 overflow-y-auto">
          {empty && (
            <div className="flex h-full flex-col items-center justify-center gap-4 px-2 text-center">
              <p className="text-sm text-muted-foreground">
                Задайте въпрос за публичните данни — отговорите се базират на наличните набори и
                посочват източници.
              </p>
              <div className="flex flex-col gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => void send(s)}
                    className="rounded-lg border bg-card px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m) =>
            m.role === 'user' ? (
              <div
                key={m.id}
                className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm text-primary-foreground"
              >
                {m.content}
              </div>
            ) : (
              <div key={m.id} className="space-y-2">
                <div className="prose prose-sm prose-slate max-w-none dark:prose-invert prose-headings:mt-2 prose-p:my-1.5 prose-ol:my-1.5 prose-ul:my-1.5 prose-li:my-0.5">
                  {m.content ? (
                    <Markdown remarkPlugins={[remarkGfm]}>
                      {completePartialMarkdown(m.content)}
                    </Markdown>
                  ) : (
                    streaming && <TypingDots />
                  )}
                </div>
                {m.citations && m.citations.length > 0 && (
                  <div className="citation space-y-1 border-l-2 border-primary/30 pl-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Източници
                    </p>
                    {m.citations.map((c) => (
                      <div key={c.datasetId} className="flex items-start gap-1 text-xs">
                        <button
                          type="button"
                          className="text-left text-primary underline-offset-2 hover:underline"
                          onClick={() => onSelectDataset(c.datasetId)}
                        >
                          {c.titleBg}
                        </button>
                        <a
                          href={c.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="shrink-0 text-muted-foreground hover:text-primary"
                        >
                          ↗
                        </a>
                      </div>
                    ))}
                  </div>
                )}
                {/* Per-turn footer: same styling live (streaming bubble — ↑/↓ tokens + ticking ⏱)
                    and after completion (persisted on the message). */}
                {streaming && m.id === messages[messages.length - 1]?.id ? (
                  <UsageFooter
                    usage={{
                      inputTokens: usage?.inputTokens ?? 0,
                      outputTokens: Math.max(genTokens, usage?.outputTokens ?? 0),
                      cachedInputTokens: usage?.cachedInputTokens ?? 0,
                    }}
                    durationMs={elapsedMs}
                    live
                  />
                ) : (
                  <UsageFooter usage={m.usage ?? null} durationMs={m.durationMs ?? null} />
                )}
              </div>
            ),
          )}
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {chatFocus && (
          <div className="flex items-center gap-1 text-xs">
            <span className="inline-flex max-w-full items-center gap-1 rounded-full bg-accent px-2.5 py-1 text-accent-foreground">
              <span className="truncate">Контекст: {chatFocus.titleBg}</span>
              <button
                type="button"
                aria-label="Премахни контекста"
                onClick={() => setChatFocus(null)}
                className="flex size-4 shrink-0 items-center justify-center rounded-full hover:bg-primary/20"
              >
                <X className="size-3" />
              </button>
            </span>
          </div>
        )}
        <div className="relative rounded-3xl border border-input bg-background shadow-sm focus-within:ring-2 focus-within:ring-ring">
          <textarea
            aria-label="Въпрос"
            value={input}
            rows={1}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder="Попитайте за публичните данни…"
            className="max-h-40 w-full resize-none bg-transparent py-3 pr-12 pl-12 text-sm placeholder:text-muted-foreground focus-visible:outline-none"
          />
          <button
            type="button"
            aria-label="Нов разговор"
            disabled={empty && !streaming && !chatFocus && !error}
            onClick={newChat}
            className="group absolute bottom-2 left-2 flex size-8 items-center justify-center rounded-full text-muted-foreground transition-all hover:scale-110 hover:bg-accent hover:text-accent-foreground active:scale-95 disabled:opacity-40 disabled:hover:scale-100 disabled:hover:bg-transparent"
          >
            <Plus className="size-4" />
            <span className={TOOLTIP}>Нов разговор</span>
          </button>
          {streaming ? (
            <button
              type="button"
              aria-label="Спри генерирането"
              onClick={stop}
              className="group absolute right-2 bottom-2 flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground transition-all hover:scale-110 hover:bg-primary/90 active:scale-95"
            >
              <Square className="size-3.5" fill="currentColor" />
              <span className={TOOLTIP}>Спри</span>
            </button>
          ) : (
            <button
              type="button"
              aria-label="Изпрати"
              disabled={input.trim() === ''}
              onClick={() => void send()}
              className="group absolute right-2 bottom-2 flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground transition-all hover:scale-110 hover:bg-primary/90 active:scale-95 disabled:opacity-40 disabled:hover:scale-100"
            >
              <ArrowUp className="size-4" />
              <span className={TOOLTIP}>Изпрати</span>
            </button>
          )}
        </div>
      </div>

      {!user ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center p-6 text-center">
          <p className="max-w-[16rem] text-sm text-muted-foreground">
            <Link to="/auth/login" className="font-medium text-primary hover:underline">
              Влезте
            </Link>{' '}
            в профила си, за да използвате чата.
          </p>
        </div>
      ) : null}
    </section>
  );
}
