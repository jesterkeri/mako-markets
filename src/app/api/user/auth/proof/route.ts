// ----------------------------------------------------------------------------
// POST /api/user/auth/proof
// Body: { privyAccessToken: string }
//
// Step one of an email sign-in under the inbox-takeover gate (mako-design INBOX_GAP_PLAN r18, item 1). Reads the Privy
// user and its wallet with the app secret and runs the gate; a user who may not sign in gets its status (enroll the
// authenticator, create the wallet, or contact support) and nothing else. A user who may gets a single-use nonce bound
// to its Privy user and wallet, which the browser frames into the sign-in message its embedded wallet signs (Privy
// asks the authenticator first) and sends to POST /api/user/auth. No session, no account data, no Safe address here.
//
// The enrollment checkpoint (migration 0014): when this read shows exactly one factor, an authenticator, and no embedded
// wallet on any chain, the server records that here BEFORE answering `wallet_required`, and the browser creates the
// wallet only after this answer. A first admission requires the checkpoint. If it cannot be recorded the answer is 503,
// never `wallet_required`, so no wallet is ever created that the checkpoint does not precede.
// ----------------------------------------------------------------------------

import { db } from '@/db/client';
import { checkSameOrigin } from '@/lib/csrf';
import { detectEmailMismatch, readAdmission, readCheckpoint, recordCheckpoint } from '@/lib/privy-admission';
import { recordPrivyMismatch } from '@/lib/privy-mismatch';
import { issueProofNonce } from '@/lib/privy-proof';
import { checkpointFrom } from '@/lib/privy-gate';
import { judgeAccount, PrivyConfigError, readPrivyAccount, type PrivyAccountRead } from '@/lib/privy-server';

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

  let read: PrivyAccountRead;
  try {
    read = await readPrivyAccount(body.privyAccessToken);
  } catch (err) {
    if (err instanceof PrivyConfigError) return Response.json({ error: 'internal' }, { status: 500 });
    return Response.json({ error: 'bad_token' }, { status: 401 });
  }
  if (!read.email) return Response.json({ error: 'no_email' }, { status: 422 });

  // [J2] C4 before anything else (see /api/user/auth): a moved login email is refused and recorded here, before an
  // enrollment or a nonce is offered.
  const moved = await detectEmailMismatch(read.privyUserId, read.email);
  if (moved) {
    await recordPrivyMismatch(moved.id, moved.observedEmail);
    return Response.json({ ok: false, status: 'email_changed' }, { status: 403 });
  }

  const checkpointNow = checkpointFrom(read.user);
  if (checkpointNow) {
    try {
      await recordCheckpoint(db, read.privyUserId, checkpointNow);
    } catch (err) {
      console.error('[user/auth/proof] checkpoint write failed', err instanceof Error ? err.name : 'unknown');
      return Response.json({ error: 'unavailable' }, { status: 503 });
    }
  }

  const admission = await readAdmission(read.privyUserId);
  const verdict = judgeAccount(read, admission, admission ? null : await readCheckpoint(db, read.privyUserId));
  if (!verdict.ok) {
    const flow = verdict.status === 'mfa_enrollment_required' || verdict.status === 'wallet_required';
    return Response.json({ ok: false, status: verdict.status }, { status: flow ? 200 : 403 });
  }
  const nonce = await issueProofNonce(db, read.privyUserId, verdict.wallet, Date.now());
  return Response.json({ ok: true, status: 'proof_required', nonce });
}
