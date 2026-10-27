// ----------------------------------------------------------------------------
// POST /api/user/sign-out-everywhere
//
// Remembered browsers (SIGNIN_REMEMBERED_BROWSER_PLAN r29 2.3, owner decision Q-F): ends every Mako session of the
// account and forgets every remembered browser, so the next sign-in anywhere needs a fresh email code. It first reads
// the Privy user and raises the account's recorded email verification to the email account's current
// latest_verified_at, so no verification made before it can ever bind afterwards; if Privy cannot be read the whole
// action fails and asks to try again. Then, in one transaction holding the account's lock: every verified unspent
// ceremony voided first, then every row revoked and every session deleted.
//
// Answers { ok: true, authed: false } and clears this browser's cookies; 401 without a session; 503 when Privy or the
// database cannot be reached (nothing changed).
// ----------------------------------------------------------------------------

import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { users } from '@/db/schema';
import { checkSameOrigin } from '@/lib/csrf';
import { readPrivyAccountById } from '@/lib/privy-server';
import { setBrowserCookie, signOutEverywhere } from '@/lib/remembered-browser';
import { emailLatestVerifiedAt } from '@/lib/remembered-browser-rules';
import { getUserSession, USER_SESSION_COOKIE } from '@/lib/user-session';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  if (!checkSameOrigin(req).ok) return Response.json({ error: 'cross_origin' }, { status: 403 });
  const session = await getUserSession();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });

  try {
    const acct = await db.select({ privyUserId: users.privyUserId }).from(users).where(eq(users.id, session.userId)).limit(1);
    const privyUserId = acct[0]?.privyUserId ?? null;
    const currentValue = privyUserId ? emailLatestVerifiedAt(await readPrivyAccountById(privyUserId)) : null;
    await signOutEverywhere({ userId: session.userId, privyUserId, currentValue });
  } catch (err) {
    console.error('[user/sign-out-everywhere] failed', err instanceof Error ? err.name : 'unknown');
    return Response.json({ error: 'unavailable' }, { status: 503 });
  }

  const store = await cookies();
  setBrowserCookie(store, null);
  store.set(USER_SESSION_COOKIE, '', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 0 });
  return Response.json({ ok: true, authed: false });
}
