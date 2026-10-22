import 'server-only';

import { sql } from 'drizzle-orm';

import { db } from '@/db/client';

/// The bell's unread count (#214, NOTIFICATIONS_PLAN r8 §3.5), capped at UNREAD_CAP; /api/user/me carries it, so the
/// badge costs no request of its own. Any failure answers null (no badge) and never fails /me.
export const UNREAD_CAP = 100;

export async function unreadCount(userId: string): Promise<number | null> {
  try {
    const res = await db.execute(sql`
      SELECT count(*)::int AS n FROM (
        SELECT 1 FROM notifications WHERE user_id = ${userId}::uuid AND read_at IS NULL LIMIT ${UNREAD_CAP}
      ) t`);
    const raw = (res as unknown as { rows?: unknown[] }).rows ?? (res as unknown as unknown[]);
    const n = Number((raw as { n: number | string }[])[0]?.n);
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch (err) {
    console.warn('[notifications] unread count failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}
