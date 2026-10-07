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
import { detectEmailMismatch, hasLiveCheckpoint, isBoundToAccount, readAdmission, readCheckpoint } from '@/lib/privy-admission';
import { deletePrivyUser, judgeAccount, PrivyConfigError, readPrivyAccount, type PrivyAccountRead } from '@/lib/privy-server';
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

  const nowMs = Date.now();
  let decision: ReturnType<typeof startOverDecision>;
  try {
    const moved = await detectEmailMismatch(read.privyUserId, read.email);
    const admission = await readAdmission(read.privyUserId);
    const checkpoint = admission ? null : await readCheckpoint(db, read.privyUserId, checkpointHashFrom(req), nowMs);
    const verdict = judgeAccount(read, admission, checkpoint);
    decision = startOverDecision({
      verdictStatus: verdict.ok ? 'ok' : verdict.status,
      boundToAccount: await isBoundToAccount(db, read.privyUserId),
      emailMoved: moved !== null,
      liveCheckpoint: await hasLiveCheckpoint(db, read.privyUserId, nowMs),
    });
  } catch (err) {
    console.error('[user/auth/start-over] read failed', err instanceof Error ? err.name : 'unknown');
    return Response.json({ error: 'unavailable' }, { status: 503 });
  }
  if (!decision.eligible) return Response.json({ ok: false, status: decision.reason }, { status: 409 });

  try {
    await deletePrivyUser(read.privyUserId);
  } catch (err) {
    console.error('[user/auth/start-over] Privy delete failed', err instanceof Error ? err.name : 'unknown');
    return Response.json({ error: 'unavailable' }, { status: 503 });
  }
  // An audit line: which unfinished Privy identity was cleared (an id, no email).
  console.info('[user/auth/start-over] deleted unfinished Privy user', read.privyUserId);
  const store = await cookies();
  store.set(ENROLL_CHECKPOINT_COOKIE, '', { path: '/api/user/auth', maxAge: 0 });
  return Response.json({ ok: true });
}
