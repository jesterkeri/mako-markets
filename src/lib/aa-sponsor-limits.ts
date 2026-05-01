import 'server-only';

// ----------------------------------------------------------------------------
// src/lib/aa-sponsor-limits.ts
//
// Atomic per-(user, chain, day) increment table. The route calls
// `incrementOrReject` BEFORE invoking Pimlico; if the resulting count
// exceeds the daily cap, the route returns 429 and never spends sponsor
// budget. The race-loss path on /api/aa/sponsor (partial unique index
// rejected the INSERT) calls `decrementForRefund` so the loser's count is
// returned — `GREATEST(count - 1, 0)` plus the DB CHECK `count >= 0` guard
// against a future double-refund bug.
//
// `SPONSOR_CAP_PER_USER_PER_DAY` is count-only. Pimlico's policy server
// enforces dollar caps independently — this is a coarse local cap, not a
// dollar mirror.
// ----------------------------------------------------------------------------

import { sql } from 'drizzle-orm';

import { db } from '@/db/client';
import { SPONSOR_CAP_PER_USER_PER_DAY } from './aa-constants';

export type IncrementResult =
  | { kind: 'within_cap'; count: number }
  /// Returned count was over cap. Caller maps to 429 CAP_EXCEEDED.
  | { kind: 'cap_exceeded'; count: number };

/// Increment + return the new count, all in one autocommit statement.
/// Postgres applies row-level locking implicitly for the UPSERT, so two
/// concurrent callers serialise correctly. The CHECK constraint
/// `count >= 0` is a defensive belt against the refund path.
export async function incrementOrReject(args: {
  userId: string;
  chainId: number;
}): Promise<IncrementResult> {
  // We compose the INSERT ... ON CONFLICT ... DO UPDATE manually so the
  // RETURNING column is the post-update count, not the pre-insert default.
  const rows = await db.execute<{ count: number }>(sql`
    INSERT INTO aa_sponsor_limits (user_id, chain_id, day, count)
    VALUES (${args.userId}::uuid, ${args.chainId}, (now() AT TIME ZONE 'UTC')::date, 1)
    ON CONFLICT (user_id, chain_id, day)
    DO UPDATE SET count = aa_sponsor_limits.count + 1
    RETURNING count
  `);
  const count = Number(rows[0]?.count ?? 0);
  if (count > SPONSOR_CAP_PER_USER_PER_DAY) {
    return { kind: 'cap_exceeded', count };
  }
  return { kind: 'within_cap', count };
}

/// Refund a single increment. Used by the sponsor route's race-loss path
/// (partial unique index rejected the pending row INSERT) and the
/// PathXMismatchError pre-RPC failure. NOT used for any Pimlico-side
/// failure — those preserve the count by design (see plan §"Refund policy").
export async function decrementForRefund(args: {
  userId: string;
  chainId: number;
}): Promise<void> {
  await db.execute(sql`
    UPDATE aa_sponsor_limits
       SET count = GREATEST(count - 1, 0)
     WHERE user_id = ${args.userId}::uuid
       AND chain_id = ${args.chainId}
       AND day = (now() AT TIME ZONE 'UTC')::date
  `);
}
