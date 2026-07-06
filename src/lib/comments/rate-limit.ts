import 'server-only';

// ----------------------------------------------------------------------------
// src/lib/comments/rate-limit.ts
//
// Per-user ATTEMPT throttle for comment POSTs (plan §2 step 5, Codex r2
// MAJOR-1). Called BEFORE the getMarket RPC so bogus-marketId spam throttles
// and RPC is hard-bounded. Two windows, both incremented atomically inside one
// transaction (the incrementOrReject shape from aa-sponsor-limits.ts):
//   - 60s bucket, cap RATE_PER_MINUTE — burst / RPC guard
//   - per-UTC-calendar-day bucket, cap RATE_PER_DAY — coarse daily ceiling
//     (calendar day, not rolling; matches the sponsor limiter — the
//     <=2x-across-midnight edge is accepted, still minute-bounded).
//
// Counts ATTEMPTS (the row increments regardless of whether the later RPC
// 404s), so this is the AUTHORITATIVE cap — no second count needed. On
// rejection the transaction ROLLS BACK, so a throttled attempt consumes
// NEITHER bucket. The row-locked upsert serializes a user's concurrent POSTs,
// so N parallel requests can't all observe an under-cap count.
// ----------------------------------------------------------------------------

import { sql } from 'drizzle-orm';

import type { DbOrTx } from '@/db/client';
import { RATE_PER_DAY, RATE_PER_MINUTE } from './types';

export type ReserveResult = { ok: true } | { ok: false; scope: 'minute' | 'day' };

/// 60s fixed window: floor(epoch_seconds / 60). Matches the SQL form
/// floor(extract(epoch from now())/60).
export function minuteWindowKey(now: Date): string {
  return `m:${Math.floor(now.getTime() / 60_000)}`;
}

/// UTC calendar-day window (yyyy-mm-dd). Matches (now() AT TIME ZONE 'UTC')::date.
export function dayWindowKey(now: Date): string {
  return `d:${now.toISOString().slice(0, 10)}`;
}

/// Sentinel to unwind the transaction on an over-cap increment (drizzle rolls
/// back when the callback throws). Carries which window tripped.
class ReserveReject extends Error {
  constructor(readonly scope: 'minute' | 'day') {
    super('rate_limited');
    this.name = 'ReserveReject';
  }
}

async function increment(tx: DbOrTx, userId: string, windowKey: string): Promise<number> {
  const res = await tx.execute(sql`
    INSERT INTO comment_rate_limits (user_id, window_key, count)
    VALUES (${userId}::uuid, ${windowKey}, 1)
    ON CONFLICT (user_id, window_key)
      DO UPDATE SET count = comment_rate_limits.count + 1
    RETURNING count
  `);
  // postgres-js returns the row array directly; pglite wraps in { rows }.
  // The .rows-only form 500'd in production (draft.ts:167 lesson).
  const raw =
    (res as unknown as { rows?: unknown[] }).rows ?? (res as unknown as unknown[]);
  const rows = (Array.isArray(raw) ? raw : []) as Array<{ count: number | string }>;
  return rows.length > 0 ? Number(rows[0].count) : 0;
}

/// Reserve one attempt for `userId` at instant `now`. Returns { ok: true } when
/// both windows are under cap (both incremented, committed); otherwise
/// { ok: false, scope } and NEITHER bucket is consumed (rolled back).
export async function reserveAttemptOrReject(
  db: DbOrTx,
  userId: string,
  now: Date,
): Promise<ReserveResult> {
  const minuteKey = minuteWindowKey(now);
  const dayKey = dayWindowKey(now);
  try {
    await db.transaction(async (tx) => {
      // Minute first: an over-cap minute rejects before the day bucket is even
      // touched, so a throttled burst never consumes daily budget.
      const minute = await increment(tx, userId, minuteKey);
      if (minute > RATE_PER_MINUTE) throw new ReserveReject('minute');
      const day = await increment(tx, userId, dayKey);
      if (day > RATE_PER_DAY) throw new ReserveReject('day');
    });
    return { ok: true };
  } catch (e) {
    if (e instanceof ReserveReject) return { ok: false, scope: e.scope };
    throw e;
  }
}
