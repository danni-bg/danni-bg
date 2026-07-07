// Backend auth endpoints (spec 019). Self-service login/registration/recovery/verification are Kratos
// browser flows (driven by the SPA via the /kratos proxy); danni only adds:
//  - POST /api/auth/callback : materialize the app user (find-or-create) + report the tier
//  - POST /api/auth/logout   : hand back the Kratos browser logout URL for the SPA to follow
// Both sit behind requireAuth (a valid session is required).

import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type { AuthEnv } from '../middleware/require-auth.ts';

export function authRoutes(
  kratosPublicUrl: string,
  gate: MiddlewareHandler<AuthEnv>,
): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  // The shared auth gate (spec 055 FR-375) — identical to every other gated route, so an API key on
  // /api/auth/* now gets the same key-aware handling (401/403) instead of a generic session 401.
  app.use('*', gate);

  app.post('/callback', (c) => {
    const u = c.get('user');
    return c.json({
      user: {
        id: u.id,
        email: u.email,
        displayName: u.display_name,
        role: u.role,
        avatarUrl: u.avatar_url,
      },
      isAdmin: u.role === 'admin',
    });
  });

  app.post('/logout', (c) => {
    // The SPA initiates the Kratos browser logout flow at this URL (clears the session cookie).
    return c.json({
      logoutUrl: `${kratosPublicUrl.replace(/\/$/, '')}/self-service/logout/browser`,
    });
  });

  return app;
}
