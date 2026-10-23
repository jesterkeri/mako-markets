import { sql } from 'drizzle-orm';

import { db } from '@/db/client';
import { isUuid } from '@/lib/comments/validate';
import { getUserSession } from '@/lib/user-session';

// GET /api/notifications?cursor=<id>&limit=<1..30> -> { items: [{ id, kind, data, eventAt, read }], next }
// The signed-in user's notifications, newest first (#214, NOTIFICATIONS_PLAN r8 §3.5). Session only, and every
// query is scoped by `user_id = session.userId`, so a cursor from another account matches nothing. Keyset on
// (created_at, id): the cursor carries the last item's boundary itself, `<created_at to the microsecond, UTC>_<id>`,
// never a row to look up, so an older page never repeats an item and a pruned or deleted cursor row does not end the
// feed early. A row that rises above the cursor after the first page (a re-opened reply, plan §3.2(3)) or arrives
// since is not on an older page: it is on the top page, which the list fetches again with every "Load more" and puts
// at the top (components/notifications/NotificationList.tsx; Codex S1 code review R1 F1, R2). A cursor only bounds
// the caller's own rows. `next` is null on the last page. Signed out: 401. Never cached.

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'private, no-store' };
const CURSOR_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)_([0-9a-f-]{36})$/;

interface Row {
  id: string;
  kind: string;
  data: unknown;
  event_at: Date | string;
  read_at: Date | string | null;
  /// created_at to the microsecond, UTC, for the cursor (a JS Date would drop the microseconds).
  ca: string;
}

export async function GET(req: Request) {
  const session = await getUserSession();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });
  const params = new URL(req.url).searchParams;
  const rawLimit = params.get('limit');
  const limit = rawLimit === null ? 20 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 30) return Response.json({ error: 'bad_limit' }, { status: 400, headers: NO_STORE });
  const cursor = params.get('cursor');
  const bound = cursor === null ? null : CURSOR_RE.exec(cursor);
  if (cursor !== null && (bound === null || !isUuid(bound[2]) || Number.isNaN(Date.parse(bound[1])))) {
    return Response.json({ error: 'bad_cursor' }, { status: 400, headers: NO_STORE });
  }

  const after = bound === null ? sql`` : sql`AND (n.created_at, n.id) < (${bound[1]}::timestamptz, ${bound[2]}::uuid)`;
  const res = await db.execute(sql`
    SELECT n.id, n.kind, n.data, n.event_at, n.read_at,
           to_char(n.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ca
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
      next: rows.length > limit ? `${page[page.length - 1].ca}_${page[page.length - 1].id}` : null,
    },
    { headers: NO_STORE },
  );
}
