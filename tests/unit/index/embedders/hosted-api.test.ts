import { describe, expect, it } from 'bun:test';
import { HostedApiEmbedder } from '../../../../src/index/embedders/hosted-api.ts';
import { EmbedderHttpError } from '../../../../src/lib/errors.ts';

describe('index.embedders.hosted-api', () => {
  it('POSTs and parses an OpenAI-style response', async () => {
    let captured: { url: string; init: RequestInit | undefined } | null = null;
    const fetcher = (async (url: string | URL | Request, init?: RequestInit | undefined) => {
      captured = { url: typeof url === 'string' ? url : url.toString(), init };
      return new Response(
        JSON.stringify({ data: [{ embedding: [1, 2, 3, 4] }, { embedding: [5, 6, 7, 8] }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ) as unknown as Response;
    }) as unknown as typeof fetch;
    const e = new HostedApiEmbedder({
      endpointUrl: 'https://api/embed',
      bearer: 'TOK',
      fetcher,
      modelId: 'm',
      dimension: 4,
    });
    const out = await e.embed(['a', 'b']);
    expect(out.length).toBe(2);
    expect(out[0]?.[0]).toBe(1);
    expect(out[1]?.[3]).toBe(8);
    const headers = (captured as unknown as { init: RequestInit }).init.headers as Record<
      string,
      string
    >;
    expect(headers.authorization).toBe('Bearer TOK');
  });

  it('throws on count mismatch', async () => {
    const fetcher = (async () =>
      new Response(JSON.stringify({ data: [{ embedding: [1] }] }), {
        status: 200,
      }) as unknown as Response) as unknown as typeof fetch;
    const e = new HostedApiEmbedder({
      endpointUrl: 'https://api/embed',
      fetcher,
      modelId: 'm',
      dimension: 1,
    });
    await expect(e.embed(['a', 'b'])).rejects.toThrow();
  });

  it('throws a typed EmbedderHttpError carrying httpStatus on non-2xx (spec 054 FR-362)', async () => {
    const fetcher = (async () =>
      new Response('boom', { status: 503 }) as unknown as Response) as unknown as typeof fetch;
    const e = new HostedApiEmbedder({ endpointUrl: 'https://api/x', fetcher });
    let caught: unknown;
    try {
      await e.embed(['a']);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EmbedderHttpError);
    // The numeric status is the classification contract; the message text is free to change.
    expect((caught as EmbedderHttpError).httpStatus).toBe(503);
    expect((caught as EmbedderHttpError).details['httpStatus']).toBe(503);
  });

  it('handles missing data field defensively', async () => {
    const fetcher = (async () =>
      new Response('{}', { status: 200 }) as unknown as Response) as unknown as typeof fetch;
    const e = new HostedApiEmbedder({ endpointUrl: 'https://api/y', fetcher });
    await expect(e.embed(['a'])).rejects.toThrow();
  });

  it('builds id from modelId', () => {
    const fetcher = (async () =>
      new Response('{}', { status: 200 }) as unknown as Response) as unknown as typeof fetch;
    const e = new HostedApiEmbedder({
      endpointUrl: 'https://api/x',
      fetcher,
      modelId: 'multilingual-mini',
    });
    expect(e.id).toBe('hosted-api:multilingual-mini');
    expect(e.dimension).toBe(384);
  });

  it('leaves maxBatchSize unset when not supplied', () => {
    const fetcher = (async () =>
      new Response('{}', { status: 200 }) as unknown as Response) as unknown as typeof fetch;
    const e = new HostedApiEmbedder({ endpointUrl: 'https://api/x', fetcher });
    expect(e.maxBatchSize).toBeUndefined();
  });

  it('surfaces a constructor-supplied maxBatchSize (provider hard cap, FR-005)', () => {
    const fetcher = (async () =>
      new Response('{}', { status: 200 }) as unknown as Response) as unknown as typeof fetch;
    const e = new HostedApiEmbedder({ endpointUrl: 'https://api/x', fetcher, maxBatchSize: 128 });
    expect(e.maxBatchSize).toBe(128);
  });
});
