import 'server-only';

// ----------------------------------------------------------------------------
// src/lib/stats-db-read.ts
//
// The /stats account figures (landed sponsored operations and the accounts behind them, Mako wallets created) read
// from the database through the stats login (src/db/stats-client.ts). Only the 15-minute scheduled job calls this
// (src/lib/stats-snapshot.ts, from /api/cron/aa-fast); the public /api/stats never reaches the database (Codex
// RELEASE_R9 #1: a role's connection cap applies only after login, so it cannot bound a burst of connection attempts
// from many server instances; one scheduled caller can).
// ----------------------------------------------------------------------------

import { sql } from 'drizzle-orm';

import { resetStatsDb, statsDb } from '@/db/stats-client';
import { MONAD_TESTNET_ID } from '@/lib/chain';
import { within } from '@/lib/within';

/// The database ends the query itself after this long (statement_timeout, scoped to the read's transaction), and the
/// caller stops waiting at the same time.
export const DB_TIMEOUT_MS = 5_000;

export type DbFigures = { gasFree: { actions: number; accounts: number }; makoWallets: number };

export class UnexpectedShape extends Error {
  override name = 'UnexpectedShape';
}
export class ReadStillRunning extends Error {
  override name = 'ReadStillRunning';
}

/// What holds this instance's one stats connection, or null when nothing does (Codex RELEASE_R7 #2: a hung database
/// must never collect a pile of reads). Only a CONFIRMED close frees it (Codex RELEASE_R11 #1):
///   read          a read is in flight;
///   closing       its connection is being closed; nothing may start until the close settles;
///   close_failed  the close was refused; the old client may still be live, so nothing may start, and after
///                 STUCK_READ_MS the SAME client is closed again (never a new one).
/// A close that never settles therefore keeps the guard for the instance's life: fail closed, by design.
type Guard = { kind: 'read' | 'closing' | 'close_failed'; p: Promise<unknown>; since: number };
let guard: Guard | null = null;

/// A read still open after this long is stuck (its own limits are 5 s to connect and 5 s to run): it is abandoned and
/// its connection closed, so one stalled socket cannot stop every later run on this instance (adversary on e93214a).
export const STUCK_READ_MS = 60_000;

/// After the caller stops waiting (DB_TIMEOUT_MS), a read gets this much longer to settle, which the database's own
/// statement_timeout (also DB_TIMEOUT_MS) gives a healthy query. Still open after that, its connection is closed
/// within the same call (Codex RELEASE_R10 #1: waiting for a later run to notice let a stalled connection stay open
/// until the next scheduled run, or indefinitely if none came; a timer is no fix on a serverless instance that may be
/// frozen once it has answered).
export const STALL_GRACE_MS = 2_000;

/// A failed read as a code or class for the logs, never the message: a driver error's message can carry the
/// connection string.
export function statsErrorCode(e: unknown): string {
  // Drizzle wraps a driver error ("Failed query") and keeps the driver's code on its cause.
  const code = (e as { code?: unknown } | null)?.code ?? (e as { cause?: { code?: unknown } } | null)?.cause?.code;
  if (e instanceof UnexpectedShape) return `${e.name}: ${e.message}`;
  return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : e instanceof Error ? e.name : 'unknown';
}

/// Closes this instance's stats client while the close holds the guard. The guard is freed only if the close settles
/// successfully; a refused close leaves `close_failed`, so no new read can start while the old connection may live.
async function closeGuarded(): Promise<boolean> {
  const closing = resetStatsDb();
  const mine: Guard = { kind: 'closing', p: closing, since: performance.now() };
  guard = mine;
  try {
    await closing;
    if (guard === mine) guard = null;
    return true;
  } catch {
    if (guard === mine) guard = { kind: 'close_failed', p: closing.catch(() => {}), since: performance.now() };
    return false;
  }
}

/// Gives `read` STALL_GRACE_MS more; if it is still open and still the read in flight, closes its connection.
async function closeIfStalled(read: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    read.then(
      () => true,
      () => true,
    ),
    new Promise<false>((r) => {
      timer = setTimeout(() => r(false), STALL_GRACE_MS);
    }),
  ]);
  clearTimeout(timer);
  if (settled || guard?.kind !== 'read' || guard.p !== read) return;
  await closeGuarded();
}

/// The figures in one query, or a throw. A malformed row is a throw, never a zero.
export async function readDbFigures(): Promise<DbFigures> {
  if (guard) {
    // Ages are elapsed time (performance.now), so a wall-clock step neither holds nor drops a guard early.
    if (guard.kind === 'closing') throw new ReadStillRunning('the stats connection is still closing');
    if (performance.now() - guard.since < STUCK_READ_MS) throw new ReadStillRunning('a previous stats read is still running');
    // A read stuck past STUCK_READ_MS, or a refused close being retried: close the SAME client again. Only a confirmed
    // close lets this call go on to read.
    if (!(await closeGuarded())) throw new ReadStillRunning('the stats connection could not be closed');
    if (guard) throw new ReadStillRunning('another stats read started while the connection closed');
  }
  const read = statsDb.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = ${sql.raw(String(DB_TIMEOUT_MS))}`);
    return tx.execute<{ actions: number; accounts: number; wallets: number }>(sql`
      SELECT
        (SELECT count(*)::int FROM aa_pending_user_ops WHERE status = 'sent') AS actions,
        (SELECT count(DISTINCT safe_address)::int FROM aa_pending_user_ops WHERE status = 'sent') AS accounts,
        (SELECT count(*)::int FROM user_safes WHERE chain_id = ${MONAD_TESTNET_ID}) AS wallets
    `);
  });
  guard = { kind: 'read', p: read, since: performance.now() };
  read.then(
    () => {
      if (guard?.kind === 'read' && guard.p === read) guard = null;
    },
    () => {
      if (guard?.kind === 'read' && guard.p === read) guard = null;
    },
  );
  let rows: Awaited<typeof read>;
  try {
    rows = await within(read, DB_TIMEOUT_MS);
  } catch (e) {
    if ((e as { code?: unknown } | null)?.code === 'TIMEOUT') await closeIfStalled(read);
    throw e;
  }
  const row = Array.isArray(rows) ? rows[0] : undefined;
  // A count arrives as a number (or a digit string from some drivers); null, '' or anything else is a malformed row,
  // never a zero (Number(null) and Number('') are both 0).
  const count = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : Number.NaN);
  const actions = count(row?.actions);
  const accounts = count(row?.accounts);
  const wallets = count(row?.wallets);
  if (![actions, accounts, wallets].every((n) => Number.isInteger(n) && n >= 0)) {
    throw new UnexpectedShape(`db figures row ${Array.isArray(rows) ? 'array' : typeof rows}`);
  }
  return { gasFree: { actions, accounts }, makoWallets: wallets };
}
