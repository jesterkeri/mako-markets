import { sql } from 'drizzle-orm';

import { statsDb } from '@/db/stats-client';
import { MONAD_TESTNET_ID } from '@/lib/chain';
import { ttlMemo } from '@/lib/ttl-memo';
import { parseIndexedStats, STATS_QUERY, toWire, type IndexedStats, type StatsWire } from '@/lib/stats';

// GET /api/stats: the figures for /stats, from the Envio indexer of the pools and rounds contracts (ENVIO_GRAPHQL_URL) and Mako
// Market's own records (sponsored transactions, Mako wallets created). The indexer figures are at most a minute old and
// the database figures at most five minutes, so a new bet shows within a minute (Joshua, 2026-10-08: 30 minutes was too
// slow). Database work is bounded twice: per server instance, by the memo and the in-flight guard below; across the
// whole deployment, by the stats login's connection limit (src/db/stats-client.ts, Codex RELEASE_R8 #1).

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const INDEXER_MAX_AGE_SEC = 60;
const DB_MAX_AGE_SEC = 5 * 60;
const INDEXER_TIMEOUT_MS = 10_000;
/// A slow or unreachable database leaves the gas-free figure out rather than holding the page.
const DB_TIMEOUT_MS = 5_000;

class NotConfigured extends Error {}
class UnexpectedShape extends Error {
  override name = 'UnexpectedShape';
}

const errorCode = (e: unknown): string => {
  // Drizzle wraps a driver error ("Failed query") and keeps the driver's code on its cause.
  const code = (e as { code?: unknown } | null)?.code ?? (e as { cause?: { code?: unknown } } | null)?.cause?.code;
  if (e instanceof UnexpectedShape) return `${e.name}: ${e.message}`;
  return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : e instanceof Error ? e.name : 'unknown';
};

/// The indexer's figures, or a throw (never cached: a failure is retried on the next request, not kept for 30 minutes).
async function fetchIndexer(): Promise<IndexedStats> {
  const url = process.env.ENVIO_GRAPHQL_URL?.trim();
  if (!url) throw new NotConfigured();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: STATS_QUERY }),
    signal: AbortSignal.timeout(INDEXER_TIMEOUT_MS),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`indexer answered ${res.status}`);
  const stats = parseIndexedStats(await res.json());
  if (!stats) throw new Error('indexer answer not usable');
  return stats;
}

type DbFigures = { gasFree: NonNullable<StatsWire['gasFree']>; makoWallets: number };

class ReadStillRunning extends Error {
  override name = 'ReadStillRunning';
}

/// The database read in flight on this server instance, or null. A read that outlives the page's wait keeps running
/// on the database; while it does, no other read starts (Codex RELEASE_R7 #2: each timed-out request used to start
/// another, which a hung Neon would let pile up). At most one stats query per instance, even during an outage; the
/// stats login caps them at two across all instances.
let dbRead: Promise<unknown> | null = null;

/// Landed sponsored operations and the accounts behind them, and the Mako wallets created, in one query, or a throw.
async function fetchDbFigures(): Promise<DbFigures> {
  if (dbRead) throw new ReadStillRunning('a previous stats read is still running');
  // The database stops the query itself after DB_TIMEOUT_MS (statement_timeout, scoped to this transaction), and the
  // page stops waiting at the same time; a read the database never answers still holds the guard above until it ends.
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

// Hard age limits (src/lib/ttl-memo.ts), and a failed read shows as unavailable. The answer goes out only once both
// sources have settled, so each memo's limit leaves room for the slowest wait on the other source (adversary on
// e4a5944): an indexer figure reused at 54.9 s still goes out under 60 s after a 5 s database read, and a database
// figure reused at 289.9 s under 5 minutes after a 10 s indexer read.
const cachedIndexer = ttlMemo(INDEXER_MAX_AGE_SEC * 1000 - DB_TIMEOUT_MS, async () => toWire(await fetchIndexer(), 'ok', null, 0).indexed);
const cachedDb = ttlMemo(DB_MAX_AGE_SEC * 1000 - INDEXER_TIMEOUT_MS, fetchDbFigures);

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('timed out'), { code: 'TIMEOUT' })), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export async function GET() {
  const [indexed, dbFigures] = await Promise.allSettled([cachedIndexer(), cachedDb()]);
  // The error's code or class only: a message can carry a connection string or the indexer URL.
  if (dbFigures.status === 'rejected') console.error('[stats] database read failed:', errorCode(dbFigures.reason));
  if (indexed.status === 'rejected' && !(indexed.reason instanceof NotConfigured)) console.error('[stats] indexer read failed:', errorCode(indexed.reason));
  const body: StatsWire = {
    indexed: indexed.status === 'fulfilled' ? indexed.value.value : null,
    // Never log the reason: it can carry the indexer URL, which is configuration.
    indexedStatus: indexed.status === 'fulfilled' ? 'ok' : indexed.reason instanceof NotConfigured ? 'not_configured' : 'unavailable',
    gasFree: dbFigures.status === 'fulfilled' ? dbFigures.value.value.gasFree : null,
    makoWallets: dbFigures.status === 'fulfilled' ? dbFigures.value.value.makoWallets : null,
    // When the oldest figure shown was read, so "read Xm ago" is true of everything on the page.
    readAt: Math.floor(Math.min(Date.now(), ...[indexed, dbFigures].flatMap((r) => (r.status === 'fulfilled' ? [r.value.at] : []))) / 1000),
  };
  // No shared caching (Codex RELEASE_R7 #1): a CDN copy would add its own age on top of the figures' and could keep
  // showing "ok" after a source went down. The memos bound each server instance to one indexer read a minute and one
  // database read every five minutes, and the stats login bounds live database reads across all instances.
  return Response.json(body, { headers: { 'Cache-Control': 'no-store' } });
}
