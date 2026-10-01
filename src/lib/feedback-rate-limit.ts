import 'server-only';

import { sql } from 'drizzle-orm';

import type { DbOrTx } from '@/db/client';
import { FEEDBACK_ANON_PER_HOUR, FEEDBACK_PER_ACCOUNT_PER_HOUR } from '@/lib/feedback';

// The feedback abuse limit (migration 0012): one counter per (key, clock hour). A signed-in sender counts against
// 'u:<userId>' (5 an hour); every signed-out sender counts against the one shared 'anon' key (30 an hour), because
// no IP address is stored. Increment-or-reject, as the comments limiter does it: the row-locked upsert serializes
// concurrent sends on the same key, and an over-cap bump throws inside the transaction so it rolls back and the
// rejected attempt consumes nothing. The same transaction deletes the key's older windows, so the table holds at most
// one row per key.

export type FeedbackLimitKey = { key: string; cap: number };

export function feedbackLimitKey(userId: string | null): FeedbackLimitKey {
  return userId ? { key: `u:${userId}`, cap: FEEDBACK_PER_ACCOUNT_PER_HOUR } : { key: 'anon', cap: FEEDBACK_ANON_PER_HOUR };
}

/// The clock-hour window: floor(epoch_seconds / 3600).
export function hourWindowKey(now: Date): string {
  return `h:${hourNumber(now)}`;
}

function hourNumber(now: Date): number {
  return Math.floor(now.getTime() / 3_600_000);
}

class OverCap extends Error {
  constructor() {
    super('rate_limited');
    this.name = 'OverCap';
  }
}

/// Reserve one send for `limit` at `now`: true when it fits (counted and committed), false when the hour is full
/// (nothing counted). A database error propagates, so the caller refuses to send rather than send unlimited.
export async function reserveFeedback(db: DbOrTx, limit: FeedbackLimitKey, now: Date): Promise<boolean> {
  const windowKey = hourWindowKey(now);
  try {
    await db.transaction(async (tx) => {
      const res = await tx.execute(sql`
        INSERT INTO feedback_rate_limits (key, window_key, count)
        VALUES (${limit.key}, ${windowKey}, 1)
        ON CONFLICT (key, window_key)
          DO UPDATE SET count = feedback_rate_limits.count + 1
        RETURNING count
      `);
      // postgres-js returns the rows array itself; pglite wraps it in { rows }.
      const raw = (res as unknown as { rows?: unknown[] }).rows ?? (res as unknown as unknown[]);
      const rows = (Array.isArray(raw) ? raw : []) as Array<{ count: number | string }>;
      const count = rows.length > 0 ? Number(rows[0].count) : Number.POSITIVE_INFINITY;
      if (count > limit.cap) throw new OverCap();
      // Only OLDER hours: a request stamped in an earlier hour (a server clock a little behind) must never delete the
      // current hour's count. window_key is 'h:<digits>' (CHECK feedback_rate_limits_window_chk), compared as a number.
      await tx.execute(
        sql`DELETE FROM feedback_rate_limits WHERE key = ${limit.key} AND substring(window_key from 3)::bigint < ${hourNumber(now)}`,
      );
    });
    return true;
  } catch (e) {
    if (e instanceof OverCap) return false;
    throw e;
  }
}
