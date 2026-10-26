// ----------------------------------------------------------------------------
// POST /api/user/auth/email-verified  (step A)
// Body: { privyAccessToken: string }  + the `mako_ec` cookie from /api/user/auth/email-start
//
// Remembered browsers (SIGNIN_REMEMBERED_BROWSER_PLAN r29 2.2, step A): called by the dialog immediately after Privy's
// loginWithCode resolves, with the token the FIRST getAccessToken() after it returned, before any other Privy call
// (enrollment, wallet creation, the proof), and retried with that same token. It verifies the token, reads the Privy
// user, and records the ceremony as verified only if:
//   - the ceremony exists, is unverified, and is under 30 minutes old (by the database clock);
//   - 0 <= token.iat - latest_verified_at <= 120 s, both Privy's clock: a code entered just before this token was
//     issued. A retained or copied session refreshes to a fresh iat but keeps an old verification, so it cannot pass;
//   - the token is at most 10 minutes old by the database clock;
//   - the verification is newer than the account's recorded mark (or none is recorded);
//   - at most 10 step-A calls on the ceremony.
// It records the session id (hashed), the Privy user and the verification value. It mints nothing, binds nothing and
// claims nothing (r13): only the bind, which needs the authenticator, claims the verification. A retry after a reply
// that was lost answers success and changes nothing (r16).
//
// Answers 200 { ok: true } or 200 { ok: false, reason } with reason too_late | other_device | not_confirmed, for the
// dialog's one line. 401 for a token that does not verify; 503 when Privy or the database cannot be read.
// ----------------------------------------------------------------------------

import { checkSameOrigin } from '@/lib/csrf';
import { PrivyConfigError, readPrivyAccount, type PrivyAccountRead } from '@/lib/privy-server';
import { accountFor, runStepA } from '@/lib/remembered-browser';
import { cookieSecret, EMAIL_CEREMONY_COOKIE, emailLatestVerifiedAt, hashSecret, hashSid } from '@/lib/remembered-browser-rules';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  if (!checkSameOrigin(req).ok) return Response.json({ error: 'cross_origin' }, { status: 403 });
  let body: { privyAccessToken?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'bad_body' }, { status: 400 });
  }
  if (typeof body.privyAccessToken !== 'string' || body.privyAccessToken.length === 0) {
    return Response.json({ error: 'bad_body' }, { status: 400 });
  }
  const secret = cookieSecret(req, EMAIL_CEREMONY_COOKIE);
  if (!secret) return Response.json({ ok: false, reason: 'not_confirmed' });

  // Privy is read before the transaction, so step A holds its ceremony row only for one short statement.
  let read: PrivyAccountRead;
  try {
    read = await readPrivyAccount(body.privyAccessToken);
  } catch (err) {
    if (err instanceof PrivyConfigError) return Response.json({ error: 'internal' }, { status: 500 });
    return Response.json({ error: 'bad_token' }, { status: 401 });
  }
  if (!read.token) return Response.json({ ok: false, reason: 'not_confirmed' });

  try {
    const account = await accountFor(read.privyUserId, read.email);
    const out = await runStepA({
      secretHash: hashSecret(secret),
      sidHash: hashSid(read.token.sessionId),
      privyUserId: read.privyUserId,
      iat: read.token.issuedAt,
      value: emailLatestVerifiedAt(read),
      seen: account?.seen ?? null,
    });
    return Response.json(out);
  } catch (err) {
    console.error('[user/auth/email-verified] failed', err instanceof Error ? err.name : 'unknown');
    return Response.json({ error: 'unavailable' }, { status: 503 });
  }
}
