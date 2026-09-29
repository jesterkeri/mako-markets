import { checkSameOrigin } from '@/lib/csrf';
import { getUserSession } from '@/lib/user-session';

// ----------------------------------------------------------------------------
// POST /api/user/email/update
//
// Email change for email accounts. Until 2026-09-29 this validated a fresh Magic DID from Magic's
// updateEmailWithUI and rewrote users.email (see git history for that flow). Accounts now sign in with Privy
// (Joshua: everyone moves to Privy) and Privy's own email-change flow is not built yet, so after the same
// guards as before the route answers 410 email_change_unavailable. The profile shows "not available yet"
// without calling it (src/lib/email-change.ts); the route refuses a hand-made request the same way.
//
// cooldown-where.ts beside this file keeps the once-a-year rule for when the flow returns.
// ----------------------------------------------------------------------------

export async function POST(req: Request) {
  const origin = checkSameOrigin(req);
  if (!origin.ok) {
    return Response.json({ error: 'cross_origin' }, { status: 403 });
  }

  const session = await getUserSession();
  if (!session) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  // Email accounts only: wallet sessions have no email to change.
  if (session.authType !== 'magic') {
    return Response.json({ error: 'wallet_session' }, { status: 400 });
  }

  return Response.json({ error: 'email_change_unavailable' }, { status: 410 });
}
