import { unstable_cache } from 'next/cache';
import { sql } from 'drizzle-orm';

import { db } from '@/db/client';
import { parseIndexedStats, STATS_QUERY, toWire, type IndexedStats, type StatsWire } from '@/lib/stats';

// GET /api/stats: the figures for /stats, from the Envio indexer of the pools and rounds contracts (ENVIO_GRAPHQL_URL) and Mako
// Market's own record of sponsored transactions. Computed at most every 30 minutes and shared by every viewer, so a
// busy page never wakes the database or the indexer per view (the database is on Neon's capped free plan).

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const REVALIDATE_SEC = 30 * 60;
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

/// Landed sponsored operations and the accounts behind them, or a throw.
async function fetchGasFree(): Promise<NonNullable<StatsWire['gasFree']>> {
  const rows = await db.execute<{ actions: number; accounts: number }>(sql`
    SELECT count(*)::int AS actions, count(DISTINCT safe_address)::int AS accounts
    FROM aa_pending_user_ops
    WHERE status = 'sent'
  `);
  const row = Array.isArray(rows) ? rows[0] : undefined;
  const actions = Number(row?.actions);
  const accounts = Number(row?.accounts);
  if (!Number.isInteger(actions) || !Number.isInteger(accounts)) throw new UnexpectedShape(`gas-free row ${Array.isArray(rows) ? 'array' : typeof rows}`);
  return { actions, accounts };
}

// IndexedStats carries bigints, which the data cache cannot serialise, so the cache holds the wire shape.
// v2: the wire shape gained `rounds`; a new key so no cached v1 answer (without it) is ever served to the new page.
const cachedIndexer = unstable_cache(async () => toWire(await fetchIndexer(), 'ok', null, 0).indexed, ['stats-indexer-v2'], { revalidate: REVALIDATE_SEC });
const cachedGasFree = unstable_cache(fetchGasFree, ['stats-gasfree-v1'], { revalidate: REVALIDATE_SEC });

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('timed out'), { code: 'TIMEOUT' })), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export async function GET() {
  const [indexed, gasFree] = await Promise.allSettled([cachedIndexer(), within(cachedGasFree(), DB_TIMEOUT_MS)]);
  // The error's code or class only: a message can carry a connection string or the indexer URL.
  if (gasFree.status === 'rejected') console.error('[stats] gas-free read failed:', errorCode(gasFree.reason));
  if (indexed.status === 'rejected' && !(indexed.reason instanceof NotConfigured)) console.error('[stats] indexer read failed:', errorCode(indexed.reason));
  const body: StatsWire = {
    indexed: indexed.status === 'fulfilled' ? indexed.value : null,
    // Never log the reason: it can carry the indexer URL, which is configuration.
    indexedStatus: indexed.status === 'fulfilled' ? 'ok' : indexed.reason instanceof NotConfigured ? 'not_configured' : 'unavailable',
    gasFree: gasFree.status === 'fulfilled' ? gasFree.value : null,
    readAt: Math.floor(Date.now() / 1000),
  };
  return Response.json(body, { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=1800' } });
}
