// GET /api/pools/[id]/history: the pool's YES share after each bet, from the Envio indexer (ENVIO_GRAPHQL_URL).
// Cached 15 seconds per pool and shared by every viewer.
//   200 { points: { t, yesBps }[], bets, indexedYes, indexedNo }   t = unix seconds, oldest first
//   400 bad_id · 404 unknown_pool · 422 too_many · 503 not_configured · 502 upstream_failed

import { unstable_cache } from 'next/cache';

import { fetchPoolHistory, type PoolHistory } from '@/lib/pool-history';

export const dynamic = 'force-dynamic';

/// Short, so a bet shows within seconds; the chart checks the totals against the contract and waits while they differ.
const REVALIDATE_SEC = 15;
const TIMEOUT_MS = 10_000;

const cached = unstable_cache(
  async (url: string, id: string): Promise<PoolHistory | 'too_many' | 'unknown_pool'> =>
    fetchPoolHistory(url, BigInt(id), AbortSignal.timeout(TIMEOUT_MS)),
  ['pool-history-v1'],
  { revalidate: REVALIDATE_SEC },
);

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^\d{1,9}$/.test(id)) return Response.json({ error: 'bad_id' }, { status: 400 });
  const url = process.env.ENVIO_GRAPHQL_URL?.trim();
  if (!url) return Response.json({ error: 'not_configured' }, { status: 503 });
  try {
    const h = await cached(url, BigInt(id).toString());
    if (h === 'unknown_pool') return Response.json({ error: 'unknown_pool' }, { status: 404 });
    if (h === 'too_many') return Response.json({ error: 'too_many' }, { status: 422 });
    return Response.json(h, { headers: { 'cache-control': `public, max-age=${REVALIDATE_SEC}` } });
  } catch (err) {
    // The error's class only: a message could carry the indexer URL.
    console.error('[pool-history] failed:', err instanceof Error ? err.name : 'unknown');
    return Response.json({ error: 'upstream_failed' }, { status: 502 });
  }
}
