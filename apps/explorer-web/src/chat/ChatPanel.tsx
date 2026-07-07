import { ArrowUp, ChevronDown, ChevronRight, Plus, Square, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import { Link } from 'react-router-dom';
import remarkGfm from 'remark-gfm';
import { useAuth } from '../auth/AuthContext.tsx';
import { Textarea } from '../components/ui/textarea.tsx';
import { formatNumber } from '../lib/format.ts';
import { completePartialMarkdown } from '../lib/markdown.ts';
import { useExplorer } from '../store/explorerStore.ts';
import { type TurnUsage, useChatSession } from './useChatSession.ts';

// Styled hover tooltip (appears above the button); shown via group-hover so it matches the theme.
const TOOLTIP =
  'pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 whitespace-nowrap rounded-md bg-popover px-2 py-1 text-xs text-popover-foreground opacity-0 shadow-md ring-1 ring-border transition-opacity group-hover:opacity-100';

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
  const fmt = formatNumber;
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

export function ChatPanel() {
  const chatFocus = useExplorer((s) => s.chatFocus);
  const setChatFocus = useExplorer((s) => s.setChatFocus);
  const openDataset = useExplorer((s) => s.openDataset);
  const { user } = useAuth();

  // The whole session lifecycle — messages, streaming, meters, persistence, resume, history CRUD —
  // lives in the hook (spec 058); this component is layout, rendering, and input handling only.
  const {
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
  } = useChatSession({ enabled: !!user });

  const [input, setInput] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // When a dataset focus is set ("ask about this dataset"), prefill a question about it.
  useEffect(() => {
    if (chatFocus) setInput(`Какво съдържа наборът „${chatFocus.titleBg}"?`);
  }, [chatFocus]);

  // Keep the latest message in view as the answer streams.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  function submit(text?: string) {
    const question = (text ?? input).trim();
    if (!question || streaming) return;
    setInput('');
    void send(question);
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
                      onClick={() => {
                        setHistoryOpen(false);
                        void openSession(s.id);
                      }}
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
                    onClick={() => submit(s)}
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
                          onClick={() => openDataset(c.datasetId)}
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
          <Textarea
            aria-label="Въпрос"
            value={input}
            rows={1}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Попитайте за публичните данни…"
            // Transparent composer (the border/ring live on the wrapper): neutralise the primitive's
            // own border/background/shadow/min-height/ring via overrides rather than a parallel class.
            className="max-h-40 min-h-0 resize-none rounded-none border-0 bg-transparent py-3 pr-12 pl-12 shadow-none focus-visible:ring-0"
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
              onClick={() => submit()}
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
