import { describe, expect, it } from 'bun:test';
import type { ChatCallbacks, ChatRequestBody } from './sendChat.ts';
import { dispatchSSEEvent, sendChat } from './sendChat.ts';

function streamingFetch(sseText: string): typeof fetch {
  return (async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // Emit in two chunks to exercise cross-chunk buffering.
        const mid = Math.floor(sseText.length / 2);
        controller.enqueue(new TextEncoder().encode(sseText.slice(0, mid)));
        controller.enqueue(new TextEncoder().encode(sseText.slice(mid)));
        controller.close();
      },
    });
    return { ok: true, body } as unknown as Response;
  }) as typeof fetch;
}

const body: ChatRequestBody = {
  sessionId: null,
  message: 'q',
  scope: {},
};

describe('dispatchSSEEvent', () => {
  it('routes each event type to its callback', () => {
    const calls: string[] = [];
    const cb: ChatCallbacks = {
      onSession: (id) => calls.push(`session:${id}`),
      onToken: (d) => calls.push(`token:${d}`),
      onTool: (n, s) => calls.push(`tool:${n}:${s}`),
      onCitations: (c) => calls.push(`cites:${c.length}`),
      onAnchors: (a) => calls.push(`anchors:${a.datasetIds.join(',')}`),
      onError: (m) => calls.push(`error:${m}`),
      onDone: () => calls.push('done'),
    };
    dispatchSSEEvent({ event: 'session', data: '{"sessionId":"s1"}' }, cb);
    dispatchSSEEvent({ event: 'token', data: '{"delta":"hi"}' }, cb);
    dispatchSSEEvent({ event: 'tool', data: '{"name":"mirrorSearch","status":"start"}' }, cb);
    dispatchSSEEvent({ event: 'citations', data: '{"citations":[{"datasetId":"d1"}]}' }, cb);
    dispatchSSEEvent({ event: 'anchors', data: '{"geoEntityIds":[],"datasetIds":["d1"]}' }, cb);
    dispatchSSEEvent({ event: 'error', data: '{"message":"boom"}' }, cb);
    dispatchSSEEvent({ event: 'done', data: '{}' }, cb);
    expect(calls).toEqual([
      'session:s1',
      'token:hi',
      'tool:mirrorSearch:start',
      'cites:1',
      'anchors:d1',
      'error:boom',
      'done',
    ]);
  });

  it('ignores unknown events and tolerates missing callbacks', () => {
    expect(() => dispatchSSEEvent({ event: 'mystery', data: '{}' }, {})).not.toThrow();
    expect(() => dispatchSSEEvent({ event: 'token', data: '{"delta":"x"}' }, {})).not.toThrow();
  });
});

describe('sendChat (streaming IO)', () => {
  it('reads the SSE body across chunks and fires callbacks in order', async () => {
    const sse =
      'event: session\ndata: {"sessionId":"s1"}\n\n' +
      'event: token\ndata: {"delta":"Hi"}\n\n' +
      'event: done\ndata: {}\n\n';
    const seen: string[] = [];
    await sendChat(
      body,
      {
        onSession: (id) => seen.push(`s:${id}`),
        onToken: (d) => seen.push(`t:${d}`),
        onDone: () => seen.push('done'),
      },
      streamingFetch(sse),
    );
    expect(seen).toEqual(['s:s1', 't:Hi', 'done']);
  });

  it('reports an error when the response has no body', async () => {
    const errors: string[] = [];
    const noBodyFetch = (async () =>
      ({ ok: true, body: null }) as unknown as Response) as typeof fetch;
    await sendChat(body, { onError: (m) => errors.push(m) }, noBodyFetch);
    expect(errors).toEqual(['no response stream']);
  });

  it('forwards the abort signal to fetch', async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const capturingFetch = (async (_url: string, init?: RequestInit) => {
      seenSignal = init?.signal ?? undefined;
      return {
        ok: true,
        body: new ReadableStream({ start: (c) => c.close() }),
      } as unknown as Response;
    }) as typeof fetch;
    await sendChat(body, {}, capturingFetch, controller.signal);
    expect(seenSignal).toBe(controller.signal);
  });

  it('surfaces a non-OK JSON error envelope', async () => {
    const errors: string[] = [];
    const badFetch = (async () =>
      ({
        ok: false,
        status: 400,
        json: async () => ({ error: { message: 'invalid chat request' } }),
      }) as unknown as Response) as typeof fetch;
    await sendChat(body, { onError: (m) => errors.push(m) }, badFetch);
    expect(errors).toEqual(['invalid chat request']);
  });
});
