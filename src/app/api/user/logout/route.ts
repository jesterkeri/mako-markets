import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { users } from '@/db/schema';
import { checkSameOrigin } from '@/lib/csrf';
import { browserIsBound, forgetBrowser, rememberedBrowserEnabled, setBrowserCookie } from '@/lib/remembered-browser';
import { cookieSecret, hashSecret, REMEMBERED_BROWSER_COOKIE } from '@/lib/remembered-browser-rules';
import {
  USER_SESSION_COOKIE,
  getUserSession,
  revokeSession,
} from '@/lib/user-session';

// ----------------------------------------------------------------------------
// POST /api/user/logout
// Body (optional): { forget?: true }
//
// Revokes the current session by deleting the sessions row, then clears the
// cookie. Idempotent: a request with no session, an expired session, or a
// stale cookie all succeed — the only outcome that matters is "the cookie
// no longer authenticates a user".
//
// Success response: { ok: true, authed: false, bound }. `ok: true` keeps any caller
// that checks `body.ok` happy; `authed: false` is the value the client
// writes into queryClient.setQueryData(['user'], ...) to flip the auth UI
// without waiting for /api/user/me to be re-fetched.
//
// Remembered browsers (SIGNIN_REMEMBERED_BROWSER_PLAN r29 2.5): `bound` says whether this browser holds an active
// binding of the account (its httpOnly `mako_rb`, which the client cannot read). Ordinary sign-out keeps the Privy
// session and the binding when bound; the client ends the Privy session unless `bound` is true, so an unbound Privy
// session is never left behind. `forget: true` ("Sign out and forget this browser", for shared computers) also revokes
// this browser's row, in the lock order: the account's lock, the row, then this session; the client then ends the
// Privy session too.
//
// Same-origin gate is applied for symmetry with /api/user/auth and to block
// drive-by logout attacks (low-impact but free to defend against).
// ----------------------------------------------------------------------------

export async function POST(req: Request) {
  const origin = checkSameOrigin(req);
  if (!origin.ok) {
    return Response.json({ error: 'cross_origin' }, { status: 403 });
  }

  let forget = false;
  try {
    const body = (await req.json()) as { forget?: unknown } | null;
    forget = body?.forget === true;
  } catch {
    // No body: an ordinary sign-out.
  }

  const store = await cookies();
  const rb = cookieSecret(req, REMEMBERED_BROWSER_COOKIE);
  const rbHash = rb ? hashSecret(rb) : null;
  const session = await getUserSession();
  let bound = false;
  if (session) {
    if (forget && session.authType === 'magic') {
      const acct = await db.select({ privyUserId: users.privyUserId }).from(users).where(eq(users.id, session.userId)).limit(1);
      await forgetBrowser({ userId: session.userId, privyUserId: acct[0]?.privyUserId ?? null, deviceSecretHash: rbHash, sessionId: session.sessionId });
    } else {
      bound = session.authType === 'magic' && rememberedBrowserEnabled() && (await browserIsBound(session.userId, rbHash));
      await revokeSession(session.sessionId);
    }
  }
  if (forget) setBrowserCookie(store, null);

  store.set(USER_SESSION_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });

  return Response.json({ ok: true, authed: false, bound });
}
