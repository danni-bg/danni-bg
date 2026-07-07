import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { z } from 'zod';
import { type ParseBodyOptions, parseBody } from '../src/middleware/parse-body.ts';

const schema = z.object({ name: z.string().min(1) });

function appWith(opts?: ParseBodyOptions) {
  const app = new Hono();
  app.post('/', async (c) => {
    const parsed = await parseBody(c, schema, opts);
    if (parsed instanceof Response) return parsed;
    // `parsed` is the typed z.infer<typeof schema> here.
    return c.json({ ok: true, value: parsed });
  });
  return app;
}

const post = (app: Hono, body: string) =>
  app.request('/', { method: 'POST', body, headers: { 'content-type': 'application/json' } });

describe('middleware/parse-body (spec 055 FR-370)', () => {
  it('returns the typed parsed value on a valid body', async () => {
    const res = await post(appWith(), JSON.stringify({ name: 'danni' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, value: { name: 'danni' } });
  });

  it('400s a malformed-JSON body with the default json message', async () => {
    const res = await post(appWith(), 'not json');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: 'bad_request', message: 'invalid JSON body' },
    });
  });

  it('400s a schema failure with bad_request + the configured message, no details by default', async () => {
    const res = await post(appWith({ message: 'invalid thing' }), JSON.stringify({ name: '' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string; details?: unknown };
    };
    expect(body.error.code).toBe('bad_request');
    expect(body.error.message).toBe('invalid thing');
    expect(body.error.details).toBeUndefined();
  });

  it("details: 'flatten' attaches zod's flattened issues on a schema failure only", async () => {
    const app = appWith({ message: 'invalid settings', details: 'flatten' });
    const res = await post(app, JSON.stringify({ name: '' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { message: string; details: { fieldErrors: Record<string, string[]> } };
    };
    expect(body.error.message).toBe('invalid settings');
    expect(body.error.details.fieldErrors.name).toBeDefined();

    // Malformed JSON in flatten mode keeps the distinct json message with no details.
    const bad = await post(app, 'not json');
    expect(await bad.json()).toEqual({
      error: { code: 'bad_request', message: 'invalid JSON body' },
    });
  });

  it("details: 'string' shares the message + stringified error on BOTH failure modes (chat variant)", async () => {
    const app = appWith({ message: 'invalid chat request', details: 'string' });

    const schemaFail = await post(app, JSON.stringify({ name: '' }));
    const sfBody = (await schemaFail.json()) as { error: { message: string; details: string } };
    expect(sfBody.error.message).toBe('invalid chat request');
    // details is String(ZodError) — the stringified issues (byte-identical to chat's original catch).
    expect(sfBody.error.details).toContain('too_small');
    expect(sfBody.error.details).toContain('name');

    const jsonFail = await post(app, 'not json');
    const jfBody = (await jsonFail.json()) as { error: { message: string; details: string } };
    expect(jfBody.error.message).toBe('invalid chat request');
    expect(typeof jfBody.error.details).toBe('string');
    expect(jfBody.error.details.length).toBeGreaterThan(0);
  });
});
