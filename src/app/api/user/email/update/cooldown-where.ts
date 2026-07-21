import { and, eq, sql } from 'drizzle-orm';
import { users } from '@/db/schema';

// Cooldown WHERE for the atomic email-change UPDATE, extracted so the
// timestamp-bind rule is unit-testable (#192).
//
// `oneYearAgo` MUST bind as an ISO string, NOT a raw Date. postgres-js with
// `prepare: false` (Neon's pooled path) throws `ERR_INVALID_ARG_TYPE`
// ("Received an instance of Date") on a raw Date bind in a `sql` template —
// the same failure the aa-fast/aa-slow sweeps hit and the PM `sweepStalePending`
// fix (#163, `1cd7ca4`) documents. Rare here (fires only on a real email
// change) but a latent prod crash all the same.
//
// Defense in depth: the `IS NULL OR < cutoff` clause catches a race between the
// read-side cooldown check and this write. If two change requests race past the
// read, only one lands, because Postgres serializes writes and the loser sees
// last_email_changed_at already updated within the cooldown.
export function emailChangeCooldownWhere(
  userId: string,
  didEoa: string,
  oneYearAgo: Date,
) {
  return and(
    eq(users.id, userId),
    sql`lower(${users.magicEoa}) = lower(${didEoa})`,
    sql`(${users.lastEmailChangedAt} IS NULL OR ${users.lastEmailChangedAt} < ${oneYearAgo.toISOString()})`,
  );
}
