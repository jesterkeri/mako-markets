// ----------------------------------------------------------------------------
// POST /api/user/auth/start-over
// Body: { privyAccessToken: string }
//
// Self-service Start over for an email account that never completed its first sign-in and is locked
// (src/lib/start-over.ts holds the rule and why it is safe). Every condition is re-checked here from the server's own
// reads of Privy and the database; any failed read deletes nothing. An eligible user is first FENCED (a committed row
// that stops any first admission binding it), then deleted at Privy outside any transaction. On success the browser
// signs up again from the email step.
// ----------------------------------------------------------------------------

import { cookies } from 'next/headers';

import { db } from '@/db/client';
import { checkSameOrigin } from '@/lib/csrf';
import { checkpointHashFrom, ENROLL_CHECKPOINT_COOKIE } from '@/lib/enrollment-checkpoint';
import {
  clearCheckpoints,
  detectEmailMismatch,
  fenceStartOver,
  hasLiveCheckpoint,
  isBoundToAccount,
  lockPrivyUser,
  markStartOverDeleted,
  readAdmission,
  readCheckpoint,
} from '@/lib/privy-admission';
import { deletePrivyUser, judgeAccount, PrivyConfigError, privyUserExists, readPrivyAccount, type PrivyAccountRead } from '@/lib/privy-server';
import { startOverDecision } from '@/lib/start-over';

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

  // The re-check and the delete run under the lock a first admission takes for this Privy user (lockPrivyUser), judged on
  // the database's clock read after the wait: a sign-in in progress commits first and is then seen as bound, and one
  // that starts later finds the identity gone. Nothing is written here, so the transaction only holds the lock.
  // The email and admission reads come first, on their own: a sign-in that commits after them is caught by the bound
  // check under the lock, which startOverDecision weighs before the verdict.
  let moved: Awaited<ReturnType<typeof detectEmailMismatch>>;
  let admission: Awaited<ReturnType<typeof readAdmission>>;
  try {
    moved = await detectEmailMismatch(read.privyUserId, read.email);
    admission = await readAdmission(read.privyUserId);
  } catch (err) {
    console.error('[user/auth/start-over] read failed', err instanceof Error ? err.name : 'unknown');
    return Response.json({ error: 'unavailable' }, { status: 503 });
  }

  // Step 1, a short transaction under the lock first admissions take (lockPrivyUser), judged on the database's clock
  // after the wait: re-check eligibility, clear this user's checkpoints, and write the Start over FENCE (migration 0015).
  // It commits BEFORE Privy is asked to delete (Codex SIGNIN_R2 B1): a lock dies with its transaction, so it cannot
  // guard a remote delete that may outlive this function; the fence does, since no checkpoint of a fenced user counts.
  type Result = { kind: 'ineligible'; reason: string } | { kind: 'fenced' };
  let result: Result;
  try {
    result = await db.transaction(async (tx): Promise<Result> => {
      const nowMs = await lockPrivyUser(tx, read.privyUserId);
      const checkpoint = admission ? null : await readCheckpoint(tx, read.privyUserId, checkpointHashFrom(req), nowMs);
      const verdict = judgeAccount(read, admission, checkpoint);
      const decision = startOverDecision({
        verdictStatus: verdict.ok ? 'ok' : verdict.status,
        boundToAccount: await isBoundToAccount(tx, read.privyUserId),
        emailMoved: moved !== null,
        liveCheckpoint: await hasLiveCheckpoint(tx, read.privyUserId, nowMs),
      });
      if (!decision.eligible) return { kind: 'ineligible', reason: decision.reason };
      await clearCheckpoints(tx, read.privyUserId);
      await fenceStartOver(tx, read.privyUserId);
      return { kind: 'fenced' };
    });
  } catch (err) {
    // Rolled back: nothing cleared, nothing fenced, nothing deleted.
    console.error('[user/auth/start-over] fence failed', err instanceof Error ? err.name : 'unknown');
    return Response.json({ error: 'unavailable' }, { status: 503 });
  }
  if (result.kind === 'ineligible') return Response.json({ ok: false, status: result.reason }, { status: 409 });

  // Step 2, outside any transaction: the delete. The fence stays whatever happens; a failed or unknown delete answers
  // 503 and the next Start over (still eligible: fenced users stay locked) finishes it.
  try {
    await deletePrivyUser(read.privyUserId);
  } catch (err) {
    // The delete may still have happened at Privy (a timeout after the fact, or a second Start over finding the user
    // already gone): only Privy's own "not found" counts as deleted; anything else, or no answer, is a 503.
    const gone = await privyUserExists(read.privyUserId).then(
      (exists) => !exists,
      () => false,
    );
    if (!gone) {
      console.error('[user/auth/start-over] delete failed; fence kept', err instanceof Error ? err.name : 'unknown');
      return Response.json({ error: 'unavailable' }, { status: 503 });
    }
  }
  // Audit only: the fence protects without it, so a failure here does not change the answer.
  await markStartOverDeleted(read.privyUserId).catch((err: unknown) => {
    console.error('[user/auth/start-over] could not record the confirmed delete', err instanceof Error ? err.name : 'unknown');
  });

  // An audit line: which unfinished Privy identity was cleared (an id, no email).
  console.info('[user/auth/start-over] deleted unfinished Privy user', read.privyUserId);
  const store = await cookies();
  store.set(ENROLL_CHECKPOINT_COOKIE, '', { path: '/api/user/auth', maxAge: 0 });
  return Response.json({ ok: true });
}
