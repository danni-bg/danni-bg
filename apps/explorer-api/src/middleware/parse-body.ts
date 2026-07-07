// Shared request-body parse + validate (spec 055 FR-370). Consolidates the `try { await c.req.json() }
// catch → 400` + `safeParse → 400` block that was copy-pasted across the route modules. Returns the
// typed parsed value on success, or a 400 `Response` in the standard `{ error: { code, message } }`
// envelope that the caller returns as-is. Per-site messages (and the admin `details` flatten / chat
// stringified-error variant) stay expressible via options, so every call site keeps byte-identical
// responses (FR-377).

import type { Context } from 'hono';
import type { z } from 'zod';

export interface ParseBodyOptions {
  /** Message for a malformed-JSON body. Default `'invalid JSON body'`. Ignored in `details: 'string'`
   * mode (the chat variant), where both failure modes share `message`. */
  jsonMessage?: string;
  /** Message for a schema-validation failure. Default `'invalid request body'`. */
  message?: string;
  /**
   * What to attach under `error.details`:
   *   - `'flatten'` → zod's `flatten()` on a schema failure (admin/tenant settings surfaces); the
   *     malformed-JSON path stays detail-less with its own `jsonMessage`.
   *   - `'string'`  → the stringified underlying error on BOTH failure modes, sharing `message`
   *     (the chat `schema.parse(...)`-in-try variant).
   *   - omitted     → no details.
   */
  details?: 'flatten' | 'string';
}

/**
 * Parse + validate a JSON request body against `schema`.
 *
 * On success returns the typed value; on a malformed-JSON body or a schema failure returns a 400
 * `Response` the caller returns directly:
 * ```ts
 * const parsed = await parseBody(c, mySchema, { message: 'invalid X' });
 * if (parsed instanceof Response) return parsed;
 * // parsed is typed z.infer<typeof mySchema>
 * ```
 */
export async function parseBody<T extends z.ZodTypeAny>(
  c: Context,
  schema: T,
  opts: ParseBodyOptions = {},
): Promise<z.infer<T> | Response> {
  const { jsonMessage = 'invalid JSON body', message = 'invalid request body', details } = opts;
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch (e) {
    // 'string' mode reports the malformed-JSON parse error under the shared message (chat); every
    // other site keeps the distinct malformed-JSON message with no details.
    return details === 'string'
      ? c.json({ error: { code: 'bad_request', message, details: String(e) } }, 400)
      : c.json({ error: { code: 'bad_request', message: jsonMessage } }, 400);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const error: { code: 'bad_request'; message: string; details?: unknown } = {
      code: 'bad_request',
      message,
    };
    if (details === 'flatten') error.details = parsed.error.flatten();
    else if (details === 'string') error.details = String(parsed.error);
    return c.json({ error }, 400);
  }
  return parsed.data;
}
