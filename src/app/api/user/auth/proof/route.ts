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
// The enrollment checkpoint (migration 0014): ONLY on the dialog's explicit `checkpoint: true` request, which it sends
// right after THIS browser passed the authenticator (it finished enrolling it, or entered a fresh code to resume), and
// only when this read shows exactly one factor, an authenticator, and no embedded wallet on any chain, the server
// records that for THIS browser (a fresh secret in an httpOnly cookie, stored only as its hash) BEFORE answering
// `wallet_required`; the browser creates the wallet only after this answer. A first admission requires a checkpoint
// held by the browser signing in (src/lib/enrollment-checkpoint.ts). The plain status call never records one: the
// owner's browser could otherwise be given a checkpoint while the only authenticator was an inbox attacker's (adversary
// on fa2db07). If it cannot be recorded the answer is 503, never `wallet_required`.
// ----------------------------------------------------------------------------

import { cookies } from 'next/headers';

import { db } from '@/db/client';
import { checkSameOrigin } from '@/lib/csrf';
import {
  checkpointHashFrom,
  ENROLL_CHECKPOINT_COOKIE,
  ENROLL_CHECKPOINT_TTL_SEC,
  hashCheckpointToken,
  newCheckpointToken,
} from '@/lib/enrollment-checkpoint';
import { detectEmailMismatch, hasLiveCheckpoint, isBoundToAccount, lockPrivyUser, readAdmission, readCheckpoint, recordCheckpoint } from '@/lib/privy-admission';
import { recordPrivyMismatch } from '@/lib/privy-mismatch';
import { issueProofNonce } from '@/lib/privy-proof';
import { checkpointFrom } from '@/lib/privy-gate';
import { startOverDecision } from '@/lib/start-over';
import { judgeAccount, PrivyConfigError, readPrivyAccount, type PrivyAccountRead } from '@/lib/privy-server';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  if (!checkSameOrigin(req).ok) return Response.json({ error: 'cross_origin' }, { status: 403 });
  let body: { privyAccessToken?: unknown; checkpoint?: unknown };
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

  const nowMs = Date.now();
  const checkpointNow = body.checkpoint === true ? checkpointFrom(read.user) : null;
  if (checkpointNow) {
    const token = newCheckpointToken();
    try {
      // Under the Start over lock (lockPrivyUser; adversary on e0d63e9): a checkpoint is never committed between Start
      // over's "no live checkpoint" re-check and its Privy delete. One recorded after that delete is for an identity
      // that no longer exists, so nothing can use it (every later step reads Privy again).
      await db.transaction(async (tx) => {
        await lockPrivyUser(tx, read.privyUserId);
        await recordCheckpoint(tx, read.privyUserId, checkpointNow, hashCheckpointToken(token), new Date(nowMs + ENROLL_CHECKPOINT_TTL_SEC * 1000));
      });
      const store = await cookies();
      store.set(ENROLL_CHECKPOINT_COOKIE, token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/api/user/auth',
        maxAge: ENROLL_CHECKPOINT_TTL_SEC,
      });
    } catch (err) {
      console.error('[user/auth/proof] checkpoint write failed', err instanceof Error ? err.name : 'unknown');
      return Response.json({ error: 'unavailable' }, { status: 503 });
    }
  }

  const admission = await readAdmission(read.privyUserId);
  const checkpoint = admission ? null : await readCheckpoint(db, read.privyUserId, checkpointHashFrom(req), nowMs);
  const verdict = judgeAccount(read, admission, checkpoint);
  if (!verdict.ok) {
    const flow = verdict.status === 'mfa_enrollment_required' || verdict.status === 'wallet_required';
    if (flow) return Response.json({ ok: false, status: verdict.status }, { status: 200 });
    // A locked account that never completed its first sign-in may be offered Start over (src/lib/start-over.ts); the
    // start-over route re-checks every condition before deleting anything, so this is only a hint for the dialog.
    const offer = startOverDecision({
      verdictStatus: verdict.status,
      boundToAccount: await isBoundToAccount(db, read.privyUserId),
      emailMoved: false, // C4 answered above
      liveCheckpoint: await hasLiveCheckpoint(db, read.privyUserId, nowMs),
    });
    return Response.json({ ok: false, status: verdict.status, ...(offer.eligible ? { startOver: true } : {}) }, { status: 403 });
  }
  const nonce = await issueProofNonce(db, read.privyUserId, verdict.wallet, Date.now());
  return Response.json({ ok: true, status: 'proof_required', nonce });
}
