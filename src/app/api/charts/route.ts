// ----------------------------------------------------------------------------
// src/app/api/charts/route.ts
//
// Public chart-data endpoint. GET /api/charts?s=BTC&tf=1h
//
// Crypto candles from Coinbase (`src/lib/chart-providers/coinbase.ts`), cached per symbol and timeframe and shared by
// every viewer. A chart is a reference picture, not what a market settles on. Symbols with no free candle source
// (forex, commodities, stocks) answer 404 `no_chart_source`.
//
// Query:  s = oracle symbol (case-insensitive), tf = '1m' | '15m' | '1h' | '2h' | '4h' | '1d' (default '1h')
// Answers:
//   200 { candles: Candle[] }                 oldest first
//   400 { error: 'bad_params' }
//   404 { error: 'unknown_symbol' } | { error: 'no_chart_source' }
//   503 { error: 'rate_limited', provider: 'coinbase' }   Coinbase 429
//   502 { error: 'upstream_failed', provider?: 'coinbase' }
// ----------------------------------------------------------------------------

import { NextRequest } from 'next/server';
import { unstable_cache } from 'next/cache';
import { z } from 'zod';

import { coinbaseProductOf, getChartSymbolByOracle } from '@/lib/chart-symbols';
import { CoinbaseApiError, fetchCoinbaseCandles } from '@/lib/chart-providers/coinbase';
import type { Timeframe } from '@/types/chart';

const Query = z.object({
  s: z.string().min(1).max(20),
  tf: z.enum(['1m', '15m', '1h', '2h', '4h', '1d']).default('1h'),
});

/// Seconds a cached answer is served: about one candle's worth, never more than 30 minutes.
const TTL: Record<Timeframe, number> = {
  '1m': 30,
  '15m': 120,
  '1h': 300,
  '2h': 450,
  '4h': 600,
  '1d': 1800,
};

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const parsed = Query.safeParse({
    s: url.searchParams.get('s'),
    tf: url.searchParams.get('tf') ?? undefined,
  });
  if (!parsed.success) return Response.json({ error: 'bad_params' }, { status: 400 });

  const entry = getChartSymbolByOracle(parsed.data.s.toUpperCase());
  if (!entry) return Response.json({ error: 'unknown_symbol' }, { status: 404 });
  const product = coinbaseProductOf(entry);
  if (!product) return Response.json({ error: 'no_chart_source' }, { status: 404 });

  const tf = parsed.data.tf;
  const fetcher = unstable_cache(() => fetchCoinbaseCandles({ product, timeframe: tf }), ['charts-coinbase-v1', product, tf], {
    revalidate: TTL[tf],
  });

  try {
    const candles = await fetcher();
    return Response.json({ candles }, { headers: { 'cache-control': `public, max-age=${TTL[tf]}` } });
  } catch (err) {
    if (err instanceof CoinbaseApiError) {
      if (err.status === 429) {
        return Response.json({ error: 'rate_limited', provider: 'coinbase' }, { status: 503, headers: { 'retry-after': '30' } });
      }
      console.error('[charts] coinbase failed:', err.status ?? err.message);
      return Response.json({ error: 'upstream_failed', provider: 'coinbase' }, { status: 502 });
    }
    console.error('[charts] failed:', err instanceof Error ? err.name : 'unknown');
    return Response.json({ error: 'upstream_failed' }, { status: 502 });
  }
}
