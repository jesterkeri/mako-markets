import 'server-only';
// ----------------------------------------------------------------------------
// src/lib/db-clock.ts
//
// The database's clock, for decisions that several server instances must agree on. Each instance's Date.now() can
// differ from the others' (adversary on 8b4caaf: Start over on an instance past a checkpoint's expiry deleted the Privy
// user while a sign-in on an instance just before it was admitted), so the enrollment checkpoint is stamped and judged
// on this one clock instead. Its own module so tests can drive it apart from the instances' clocks.
// ----------------------------------------------------------------------------

import { sql } from 'drizzle-orm';

import type { DbOrTx } from '@/db/client';

/// The database's time at this statement, in ms: clock_timestamp(), not now(), which inside a transaction is the time
/// the transaction began (before any lock wait).
export async function databaseNowMs(tx: DbOrTx): Promise<number> {
  const res = (await tx.execute(sql`SELECT (extract(epoch from clock_timestamp()) * 1000)::float8 AS now_ms`)) as unknown;
  const rows = (Array.isArray(res) ? res : (res as { rows?: unknown[] }).rows) as { now_ms?: unknown }[] | undefined;
  const ms = Number(rows?.[0]?.now_ms);
  if (!Number.isFinite(ms)) throw new Error('[db-clock] clock_timestamp() returned no time');
  return Math.floor(ms);
}
