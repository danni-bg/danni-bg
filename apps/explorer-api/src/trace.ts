// Lightweight span tracing (spec 032, FR-150). A chat turn opens spans around each tool-loop step + the
// provider call, each carrying the request id and timing — emitted as structured `span` log events so a
// slow turn is attributable per step + provider latency, correlatable to its logs by request id
// (SC-F1). Vendor-neutral: an OTel collector (in the commercial deploy repo, danni-bg/deploy) can
// consume these; swap the emit for the OTel SDK later without touching call sites.
//
// PRIVACY: spans carry METADATA only (step name, durationMs, tokens, model, outcome) — never prompt or
// answer text. Attribute values are coerced to primitives; callers must not pass content strings.

import { log } from './logging.ts';

export type SpanAttrs = Record<string, string | number | boolean>;

export interface Span {
  /** Add attributes accumulated during the span. */
  setAttrs(attrs: SpanAttrs): void;
  /** Close the span, emitting one `span` event with its total duration. */
  end(attrs?: SpanAttrs): void;
}

export type SpanEmit = (event: {
  name: string;
  requestId?: string;
  durationMs: number;
  attrs: SpanAttrs;
}) => void;

const defaultEmit: SpanEmit = (e) =>
  log.info('span', {
    span: e.name,
    durationMs: e.durationMs,
    ...(e.requestId ? { requestId: e.requestId } : {}),
    ...e.attrs,
  });

export class Tracer {
  constructor(
    private readonly requestId?: string,
    private readonly now: () => number = () => Date.now(),
    private readonly emit: SpanEmit = defaultEmit,
  ) {}

  startSpan(name: string, attrs: SpanAttrs = {}): Span {
    const start = this.now();
    let acc: SpanAttrs = { ...attrs };
    let ended = false;
    return {
      setAttrs: (more) => {
        acc = { ...acc, ...more };
      },
      end: (more) => {
        if (ended) return;
        ended = true;
        this.emit({
          name,
          ...(this.requestId ? { requestId: this.requestId } : {}),
          durationMs: Math.max(0, this.now() - start),
          attrs: { ...acc, ...more },
        });
      },
    };
  }

  /** Run `fn` inside a span; records ok/error outcome + re-throws so behavior is unchanged. */
  async withSpan<T>(name: string, fn: () => Promise<T>, attrs: SpanAttrs = {}): Promise<T> {
    const span = this.startSpan(name, attrs);
    try {
      const result = await fn();
      span.end({ ok: true });
      return result;
    } catch (e) {
      span.end({ ok: false, error: e instanceof Error ? e.name : 'error' });
      throw e;
    }
  }
}
