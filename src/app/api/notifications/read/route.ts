import { sql } from 'drizzle-orm';

import { db } from '@/db/client';
import { checkSameOrigin } from '@/lib/csrf';
import { isUuid } from '@/lib/comments/validate';
import { getUserSession } from '@/lib/user-session';

// POST /api/notifications/read { ids: uuid[] } -> { updated }
// Marks exactly the notifications the panel or page RENDERED as read (#214, NOTIFICATIONS_PLAN r8 §3.5), never a
// "created up to" cut, so an item committed after the GET stays unread (and can still be emailed in S2). 1 to 30 ids,
// each a uuid, else 400. Same-origin and session; scoped by user_id, so another account's id changes nothing.

const MAX_READ_IDS = 30;

export async function POST(req: Request) {
  if (!checkSameOrigin(req).ok) return Response.json({ error: 'cross_origin' }, { status: 403 });
  const session = await getUserSession();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });
  let body: { ids?: unknown };
  try {
    body = (await req.json()) as { ids?: unknown };
  } catch {
    return Response.json({ error: 'bad_body' }, { status: 400 });
  }
  const ids = body?.ids;
  if (
    !Array.isArray(ids) ||
    ids.length < 1 ||
    ids.length > MAX_READ_IDS ||
    !ids.every((id): id is string => typeof id === 'string' && isUuid(id))
  ) {
    return Response.json({ error: 'bad_body' }, { status: 400 });
  }
  const list = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
  const res = await db.execute(sql`
    UPDATE notifications SET read_at = now()
     WHERE user_id = ${session.userId}::uuid AND read_at IS NULL AND id IN (${list})
    RETURNING id`);
  const rows = (res as unknown as { rows?: unknown[] }).rows ?? (res as unknown as unknown[]);
  return Response.json({ updated: rows.length });
}
