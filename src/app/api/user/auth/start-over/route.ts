// ----------------------------------------------------------------------------
// POST /api/user/auth/start-over
// Body: { privyAccessToken: string }
//
// Self-service Start over for an email account that never completed its first sign-in and is locked
// (src/lib/start-over.ts holds the rule and why it is safe). Every condition is re-checked here from the server's own
// reads of Privy and the database; any failed read deletes nothing. On success the unfinished Privy user is deleted
// and the browser signs up again from the email step.
// ----------------------------------------------------------------------------

import { cookies } from 'next/headers';

import { db } from '@/db/client';
import { checkSameOrigin } from '@/lib/csrf';
import { checkpointHashFrom, ENROLL_CHECKPOINT_COOKIE } from '@/lib/enrollment-checkpoint';
import { clearCheckpoints, detectEmailMismatch, hasLiveCheckpoint, isBoundToAccount, lockPrivyUser, readAdmission, readCheckpoint } from '@/lib/privy-admission';
import { deletePrivyUser, judgeAccount, PrivyConfigError, privyUserExists, readPrivyAccount, type PrivyAccountRead } from '@/lib/privy-server';
import { startOverDecision } from '@/lib/start-over';

export const runtime = 'nodejs';

/// A read or the Privy delete failed inside the locked re-check: nothing was deleted, or Privy's own answer is unknown.
class StartOverUnavailable extends Error {
  constructor(
    readonly step: 'read' | 'delete',
    readonly inner: unknown,
  ) {
    super(`start_over_${step}`);
    this.name = 'StartOverUnavailable';
  }
}

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

  type Result = { kind: 'ineligible'; reason: string } | { kind: 'deleted' };
  let result: Result;
  // Set once Privy has deleted the user: from then on the answer is success, even if the commit below fails (adversary on
  // 151cad5), since the identity is gone either way and this transaction's only write is clearing expired checkpoints.
  let privyDeleted = false;
  try {
    result = await db.transaction(async (tx): Promise<Result> => {
      const nowMs = await lockPrivyUser(tx, read.privyUserId);
      let decision: ReturnType<typeof startOverDecision>;
      try {
        const checkpoint = admission ? null : await readCheckpoint(tx, read.privyUserId, checkpointHashFrom(req), nowMs);
        const verdict = judgeAccount(read, admission, checkpoint);
        decision = startOverDecision({
          verdictStatus: verdict.ok ? 'ok' : verdict.status,
          boundToAccount: await isBoundToAccount(tx, read.privyUserId),
          emailMoved: moved !== null,
          liveCheckpoint: await hasLiveCheckpoint(tx, read.privyUserId, nowMs),
        });
      } catch (err) {
        throw new StartOverUnavailable('read', err);
      }
      if (!decision.eligible) return { kind: 'ineligible', reason: decision.reason };
      try {
        // Its (expired) checkpoints go first, in this transaction: nothing is left for a waiting sign-in to admit with.
        await clearCheckpoints(tx, read.privyUserId);
      } catch (err) {
        throw new StartOverUnavailable('read', err);
      }
      try {
        await deletePrivyUser(read.privyUserId);
      } catch (err) {
        // The delete may still have happened at Privy (a timeout after the fact, or a second Start over finding the
        // user already gone): only Privy's own "not found" counts as deleted; anything else, or no answer, is a 503.
        const gone = await privyUserExists(read.privyUserId).then(
          (exists) => !exists,
          () => false,
        );
        if (!gone) throw new StartOverUnavailable('delete', err);
      }
      privyDeleted = true;
      return { kind: 'deleted' };
    });
  } catch (err) {
    if (!privyDeleted) {
      const step = err instanceof StartOverUnavailable ? err.step : 'lock';
      const cause = err instanceof StartOverUnavailable ? err.inner : err;
      console.error(`[user/auth/start-over] ${step} failed`, cause instanceof Error ? cause.name : 'unknown');
      return Response.json({ error: 'unavailable' }, { status: 503 });
    }
    // The Privy user is deleted and only the commit failed: the sign-up is cleared all the same.
    console.error('[user/auth/start-over] commit failed after the Privy delete', err instanceof Error ? err.name : 'unknown');
    result = { kind: 'deleted' };
  }
  if (result.kind === 'ineligible') return Response.json({ ok: false, status: result.reason }, { status: 409 });

  // An audit line: which unfinished Privy identity was cleared (an id, no email).
  console.info('[user/auth/start-over] deleted unfinished Privy user', read.privyUserId);
  const store = await cookies();
  store.set(ENROLL_CHECKPOINT_COOKIE, '', { path: '/api/user/auth', maxAge: 0 });
  return Response.json({ ok: true });
}
