import { unstable_cache } from 'next/cache';
import { sql } from 'drizzle-orm';

import { db } from '@/db/client';
import { MONAD_TESTNET_ID } from '@/lib/chain';
import { parseIndexedStats, STATS_QUERY, toWire, type IndexedStats, type StatsWire } from '@/lib/stats';

// GET /api/stats: the figures for /stats, from the Envio indexer of the pools and rounds contracts (ENVIO_GRAPHQL_URL) and Mako
// Market's own records (sponsored transactions, Mako wallets created). Shared by every viewer: the indexer figures are
// at most a minute old, the database figures at most five minutes, so a busy page never wakes the database per view
// (it is on Neon's capped free plan) and a new bet shows within a minute (Joshua, 2026-10-08: 30 minutes was too slow).

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const INDEXER_REVALIDATE_SEC = 60;
const DB_REVALIDATE_SEC = 5 * 60;
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

/// Landed sponsored operations and the accounts behind them, and the Mako wallets created, in one query, or a throw.
async function fetchDbFigures(): Promise<DbFigures> {
  const rows = await db.execute<{ actions: number; accounts: number; wallets: number }>(sql`
    SELECT
      (SELECT count(*)::int FROM aa_pending_user_ops WHERE status = 'sent') AS actions,
      (SELECT count(DISTINCT safe_address)::int FROM aa_pending_user_ops WHERE status = 'sent') AS accounts,
      (SELECT count(*)::int FROM user_safes WHERE chain_id = ${MONAD_TESTNET_ID}) AS wallets
  `);
  const row = Array.isArray(rows) ? rows[0] : undefined;
  const actions = Number(row?.actions);
  const accounts = Number(row?.accounts);
  const wallets = Number(row?.wallets);
  if (![actions, accounts, wallets].every((n) => Number.isInteger(n) && n >= 0)) {
    throw new UnexpectedShape(`db figures row ${Array.isArray(rows) ? 'array' : typeof rows}`);
  }
  return { gasFree: { actions, accounts }, makoWallets: wallets };
}

// IndexedStats carries bigints, which the data cache cannot serialise, so the cache holds the wire shape.
// v2: the wire shape gained `rounds`; a new key so no cached v1 answer (without it) is ever served to the new page.
const cachedIndexer = unstable_cache(async () => toWire(await fetchIndexer(), 'ok', null, 0).indexed, ['stats-indexer-v2'], { revalidate: INDEXER_REVALIDATE_SEC });
// v2: the database figures gained the Mako wallet count.
const cachedDb = unstable_cache(fetchDbFigures, ['stats-db-v2'], { revalidate: DB_REVALIDATE_SEC });

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('timed out'), { code: 'TIMEOUT' })), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export async function GET() {
  const [indexed, dbFigures] = await Promise.allSettled([cachedIndexer(), within(cachedDb(), DB_TIMEOUT_MS)]);
  // The error's code or class only: a message can carry a connection string or the indexer URL.
  if (dbFigures.status === 'rejected') console.error('[stats] database read failed:', errorCode(dbFigures.reason));
  if (indexed.status === 'rejected' && !(indexed.reason instanceof NotConfigured)) console.error('[stats] indexer read failed:', errorCode(indexed.reason));
  const body: StatsWire = {
    indexed: indexed.status === 'fulfilled' ? indexed.value : null,
    // Never log the reason: it can carry the indexer URL, which is configuration.
    indexedStatus: indexed.status === 'fulfilled' ? 'ok' : indexed.reason instanceof NotConfigured ? 'not_configured' : 'unavailable',
    gasFree: dbFigures.status === 'fulfilled' ? dbFigures.value.gasFree : null,
    makoWallets: dbFigures.status === 'fulfilled' ? dbFigures.value.makoWallets : null,
    readAt: Math.floor(Date.now() / 1000),
  };
  // The CDN may serve a copy for a minute, and a minute more while it refreshes: never more than two minutes behind.
  return Response.json(body, { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=60' } });
}
