import { cookies } from 'next/headers';

import { checkSameOrigin } from '@/lib/csrf';
import {
  USER_SESSION_COOKIE,
  getUserSession,
  revokeSession,
} from '@/lib/user-session';

// ----------------------------------------------------------------------------
// POST /api/user/logout
//
// Revokes the current session by deleting the sessions row, then clears the
// cookie. Idempotent: a request with no session, an expired session, or a
// stale cookie all succeed — the only outcome that matters is "the cookie
// no longer authenticates a user".
//
// Success response: { ok: true, authed: false }. `ok: true` keeps any caller
// that checks `body.ok` happy; `authed: false` is the value the client
// writes into queryClient.setQueryData(['user'], ...) to flip the auth UI
// without waiting for /api/user/me to be re-fetched.
//
// Same-origin gate is applied for symmetry with /api/user/auth and to block
// drive-by logout attacks (low-impact but free to defend against).
// ----------------------------------------------------------------------------

export async function POST(req: Request) {
  const origin = checkSameOrigin(req);
  if (!origin.ok) {
    return Response.json({ error: 'cross_origin' }, { status: 403 });
  }

  const session = await getUserSession();
  if (session) {
    await revokeSession(session.sessionId);
  }

  const store = await cookies();
  store.set(USER_SESSION_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });

  return Response.json({ ok: true, authed: false });
}
