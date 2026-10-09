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

import { statsDb } from '@/db/stats-client';
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

/// The read in flight on this server instance, or null. A read that outlives the wait keeps running on the database;
/// while it does, no other read starts (Codex RELEASE_R7 #2), so a hung database never collects a pile of reads.
let dbRead: Promise<unknown> | null = null;

/// A failed read as a code or class for the logs, never the message: a driver error's message can carry the
/// connection string.
export function statsErrorCode(e: unknown): string {
  // Drizzle wraps a driver error ("Failed query") and keeps the driver's code on its cause.
  const code = (e as { code?: unknown } | null)?.code ?? (e as { cause?: { code?: unknown } } | null)?.cause?.code;
  if (e instanceof UnexpectedShape) return `${e.name}: ${e.message}`;
  return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : e instanceof Error ? e.name : 'unknown';
}

/// The figures in one query, or a throw. A malformed row is a throw, never a zero.
export async function readDbFigures(): Promise<DbFigures> {
  if (dbRead) throw new ReadStillRunning('a previous stats read is still running');
  const read = statsDb.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = ${sql.raw(String(DB_TIMEOUT_MS))}`);
    return tx.execute<{ actions: number; accounts: number; wallets: number }>(sql`
      SELECT
        (SELECT count(*)::int FROM aa_pending_user_ops WHERE status = 'sent') AS actions,
        (SELECT count(DISTINCT safe_address)::int FROM aa_pending_user_ops WHERE status = 'sent') AS accounts,
        (SELECT count(*)::int FROM user_safes WHERE chain_id = ${MONAD_TESTNET_ID}) AS wallets
    `);
  });
  dbRead = read;
  read.then(
    () => {
      if (dbRead === read) dbRead = null;
    },
    () => {
      if (dbRead === read) dbRead = null;
    },
  );
  const rows = await within(read, DB_TIMEOUT_MS);
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
