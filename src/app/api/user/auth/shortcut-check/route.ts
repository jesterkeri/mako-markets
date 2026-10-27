// ----------------------------------------------------------------------------
// POST /api/user/auth/shortcut-check
// Body: { privyAccessToken: string }  + the `mako_rb` and `mako_ec` cookies, if any
//
// Remembered browsers (SIGNIN_REMEMBERED_BROWSER_PLAN r29 2.2, "Order of prompts"): asked by the dialog BEFORE any
// authenticator prompt, so nobody sees authenticator, then email, then authenticator. Read-only: no proof, no lock, no
// write; every later step re-checks under its locks. Answers:
//   shortcut       an active row for this Privy session expiring more than 10 minutes from now, this browser's
//                  mako_rb, and an unchanged authenticator;
//   bind_possible  a usable ceremony with more than 10 of its 60 minutes left;
//   rebind         the lost-reply case (a row never used, inside its ceremony's 60 minutes, with that ceremony's mako_ec);
//   locked         Mako's own TOTP is locked out: `retryAt` says when it ends, and no code is sent meanwhile (plan 2.2
//                  case 7, the owner's stricter rule). Only to a browser that proved itself: one of the three answers
//                  above, or its own ceremony for this session that the lockout voided. A copied Privy session with
//                  neither hears email_needed, so it learns nothing of the account (Codex R1 F2); /api/user/auth
//                  enforces the lockout on its own either way;
//   email_needed   everything else: one answer for "no row" and "bad cookie", so it reveals nothing;
//   off            the feature is off (REMEMBERED_BROWSER_ENABLED unset): today's sign-in, an email code every time.
// ----------------------------------------------------------------------------

import { checkSameOrigin } from '@/lib/csrf';
import { PrivyConfigError, readPrivyAccount, type PrivyAccountRead } from '@/lib/privy-server';
import { accountFor, readShortcutState, rememberedBrowserEnabled } from '@/lib/remembered-browser';
import {
  cookieSecret,
  decideShortcutCheck,
  EMAIL_CEREMONY_COOKIE,
  factorFingerprint,
  hashSecret,
  hashSid,
  lockoutVoidedCeremony,
  REMEMBERED_BROWSER_COOKIE,
} from '@/lib/remembered-browser-rules';

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
  if (!rememberedBrowserEnabled()) return Response.json({ ok: true, status: 'off' });

  let read: PrivyAccountRead;
  try {
    read = await readPrivyAccount(body.privyAccessToken);
  } catch (err) {
    if (err instanceof PrivyConfigError) return Response.json({ error: 'internal' }, { status: 500 });
    return Response.json({ error: 'bad_token' }, { status: 401 });
  }
  if (!read.token) return Response.json({ ok: true, status: 'email_needed' });

  try {
    const sidHash = hashSid(read.token.sessionId);
    const ec = cookieSecret(req, EMAIL_CEREMONY_COOKIE);
    const rb = cookieSecret(req, REMEMBERED_BROWSER_COOKIE);
    const account = await accountFor(read.privyUserId, read.email);
    const ecHash = ec ? hashSecret(ec) : null;
    const state = await readShortcutState({ userId: account?.id ?? null, sidHash, ecHash });
    const status = decideShortcutCheck({
      sidHash,
      privyUserId: read.privyUserId,
      row: state.row,
      ceremony: state.ceremony,
      ecHash,
      rbHash: rb ? hashSecret(rb) : null,
      fingerprint: factorFingerprint(read.user),
      nowMs: state.nowMs,
    });
    const proven =
      status !== 'email_needed' ||
      lockoutVoidedCeremony(state.ceremony, { secretHash: ecHash, sidHash, privyUserId: read.privyUserId, nowMs: state.nowMs });
    if (proven && account?.hasTotp && account.totpLockedUntil && account.totpLockedUntil.getTime() > state.nowMs) {
      return Response.json({ ok: true, status: 'locked', retryAt: account.totpLockedUntil.toISOString() });
    }
    return Response.json({ ok: true, status });
  } catch (err) {
    console.error('[user/auth/shortcut-check] failed', err instanceof Error ? err.name : 'unknown');
    return Response.json({ error: 'unavailable' }, { status: 503 });
  }
}
