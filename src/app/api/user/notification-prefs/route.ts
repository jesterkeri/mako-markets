import { sql } from 'drizzle-orm';

import { db } from '@/db/client';
import { NOTIFY_WRITE_LIMIT, reserveAttemptOrReject } from '@/lib/comments/rate-limit';
import { checkSameOrigin } from '@/lib/csrf';
import { parsePrefs, parsePrefsPatch, prefsSet } from '@/lib/notifications/prefs';
import { getUserSession } from '@/lib/user-session';

// GET  /api/user/notification-prefs?account=0x…                         -> { prefs }
// POST /api/user/notification-prefs  { account, kinds?: {<kind>: boolean}, email?: boolean } -> { prefs }
// The signed-in user's notification switches (#214, NOTIFICATIONS_PLAN r8 §3.4). Copies /api/user/chart-colors'
// checks: same-origin on writes, session, own row only, and a 409 if `account` (wallet, or Safe for email accounts)
// is no longer the session's account. It does NOT copy that route's flat merge: the write is prefsSet, which changes
// only the named switches over any stored value. Only the six kinds and only booleans; at least one field; anything
// else is a 400. Writes share the notify write throttle (20 a minute, 300 a day). Signed out: 401.

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/// The session's own row, and only while `account` (any case) is its wallet address or one of its Safes.
const ownRow = (userId: string, account: string) => sql`
  id = ${userId}::uuid AND (lower(wallet_address) = ${account.toLowerCase()}
    OR EXISTS (SELECT 1 FROM user_safes s WHERE s.user_id = users.id AND lower(s.safe_address) = ${account.toLowerCase()}))`;

const rowsOf = (res: unknown) =>
  ((res as { rows?: unknown[] }).rows ?? (res as unknown[])) as { notification_prefs: unknown }[];

export async function GET(req: Request) {
  const session = await getUserSession();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const account = new URL(req.url).searchParams.get('account') ?? '';
  if (!ADDRESS_RE.test(account)) return Response.json({ error: 'bad_account' }, { status: 400 });
  const rows = rowsOf(await db.execute(sql`SELECT notification_prefs FROM users WHERE ${ownRow(session.userId, account)} LIMIT 1`));
  if (rows.length === 0) return Response.json({ error: 'account_changed' }, { status: 409 });
  return Response.json({ prefs: parsePrefs(rows[0].notification_prefs) }, { headers: { 'Cache-Control': 'private, no-store' } });
}

export async function POST(req: Request) {
  if (!checkSameOrigin(req).ok) return Response.json({ error: 'cross_origin' }, { status: 403 });
  const session = await getUserSession();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: 'bad_body' }, { status: 400 });
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return Response.json({ error: 'bad_body' }, { status: 400 });
  if (Object.keys(body).some((k) => k !== 'account' && k !== 'kinds' && k !== 'email')) return Response.json({ error: 'bad_body' }, { status: 400 });
  if (typeof body.account !== 'string' || !ADDRESS_RE.test(body.account)) return Response.json({ error: 'bad_body' }, { status: 400 });
  const patch = parsePrefsPatch(body);
  if (!patch) return Response.json({ error: 'bad_body' }, { status: 400 });
  const reserved = await reserveAttemptOrReject(db, session.userId, new Date(), NOTIFY_WRITE_LIMIT);
  if (!reserved.ok) return Response.json({ error: 'rate_limited', scope: reserved.scope }, { status: 429 });
  const rows = rowsOf(
    await db.execute(sql`
      UPDATE users SET notification_prefs = ${prefsSet(patch)}
       WHERE ${ownRow(session.userId, body.account)}
      RETURNING notification_prefs`),
  );
  if (rows.length === 0) return Response.json({ error: 'account_changed' }, { status: 409 });
  return Response.json({ prefs: parsePrefs(rows[0].notification_prefs) });
}
