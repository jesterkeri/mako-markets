import { sql } from 'drizzle-orm';

import { db } from '@/db/client';
import { isUuid } from '@/lib/comments/validate';
import { getUserSession } from '@/lib/user-session';

// GET /api/notifications?cursor=<id>&limit=<1..30> -> { items: [{ id, kind, data, eventAt, read }], next }
// The signed-in user's notifications, newest first (#214, NOTIFICATIONS_PLAN r8 §3.5). Session only, and every
// query is scoped by `user_id = session.userId`, so a cursor from another account matches nothing. Keyset on
// (created_at, id): the cursor is the last item's id, compared through its own row so no timestamp precision is lost.
// `next` is null on the last page. Signed out: 401. Never cached.

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'private, no-store' };

interface Row {
  id: string;
  kind: string;
  data: unknown;
  event_at: Date | string;
  read_at: Date | string | null;
}

export async function GET(req: Request) {
  const session = await getUserSession();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });
  const params = new URL(req.url).searchParams;
  const rawLimit = params.get('limit');
  const limit = rawLimit === null ? 20 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 30) return Response.json({ error: 'bad_limit' }, { status: 400, headers: NO_STORE });
  const cursor = params.get('cursor');
  if (cursor !== null && !isUuid(cursor)) return Response.json({ error: 'bad_cursor' }, { status: 400, headers: NO_STORE });

  const after =
    cursor === null
      ? sql``
      : sql`AND (n.created_at, n.id) < (SELECT c.created_at, c.id FROM notifications c WHERE c.id = ${cursor}::uuid AND c.user_id = ${session.userId}::uuid)`;
  const res = await db.execute(sql`
    SELECT n.id, n.kind, n.data, n.event_at, n.read_at
      FROM notifications n
     WHERE n.user_id = ${session.userId}::uuid ${after}
     ORDER BY n.created_at DESC, n.id DESC
     LIMIT ${limit + 1}`);
  const rows = ((res as unknown as { rows?: unknown[] }).rows ?? (res as unknown as unknown[])) as Row[];
  const page = rows.slice(0, limit);
  return Response.json(
    {
      items: page.map((r) => ({
        id: r.id,
        kind: r.kind,
        data: r.data,
        eventAt: new Date(r.event_at).toISOString(),
        read: r.read_at !== null,
      })),
      next: rows.length > limit ? page[page.length - 1].id : null,
    },
    { headers: NO_STORE },
  );
}
