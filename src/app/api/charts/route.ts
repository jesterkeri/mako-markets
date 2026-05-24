// ----------------------------------------------------------------------------
// src/app/api/charts/route.ts
//
// Public chart-data endpoint. GET /api/charts?s=BTC&tf=1h
//
// Single provider: Pyth Benchmarks (TradingView shim). Free, no key,
// region-stable, same source as the cf-worker resolver — so the
// chart matches what the market settles against.
//
// Query schema (zod):
//   - s: oracleSymbol (canonical on-chain form, case-insensitive)
//   - tf: '15m' | '1h' | '2h' | '4h' | '1d' (default '1h')
//
// Responses:
//   200 { candles: Candle[] }
//   400 { error: 'bad_params' }
//   404 { error: 'unknown_symbol' }
//   503 { error: 'rate_limited', provider: 'pyth' }   // Pyth 429 upstream
//   502 { error: 'upstream_failed', provider?: 'pyth' }
// ----------------------------------------------------------------------------

import { NextRequest } from 'next/server';
import { unstable_cache } from 'next/cache';
import { z } from 'zod';

import { getChartSymbolByOracle } from '@/lib/chart-symbols';
import {
  fetchPythCandles,
  PythApiError,
} from '@/lib/chart-providers/pyth';
import type { Timeframe } from '@/types/chart';

const Query = z.object({
  s:  z.string().min(1).max(20),
  tf: z.enum(['15m', '1h', '2h', '4h', '1d']).default('1h'),
});

const TTL: Record<Timeframe, number> = {
  '15m':  120,
  '1h':   300,
  '2h':   450,
  '4h':   600,
  '1d':  1800,
};

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const parsed = Query.safeParse({
    s:  url.searchParams.get('s'),
    tf: url.searchParams.get('tf') ?? undefined,
  });
  if (!parsed.success) {
    return Response.json({ error: 'bad_params' }, { status: 400 });
  }

  const oracleSymbol = parsed.data.s.toUpperCase();
  const entry = getChartSymbolByOracle(oracleSymbol);
  if (!entry) {
    return Response.json({ error: 'unknown_symbol' }, { status: 404 });
  }

  const tf = parsed.data.tf;

  const fetcher = unstable_cache(
    async () => fetchPythCandles({
      providerSymbol: entry.providerSymbol,
      timeframe: tf,
    }),
    ['charts', entry.providerSymbol, tf],
    { revalidate: TTL[tf] },
  );

  try {
    const candles = await fetcher();
    return Response.json(
      { candles },
      { headers: { 'cache-control': `public, max-age=${TTL[tf]}` } },
    );
  } catch (err) {
    if (err instanceof PythApiError) {
      if (err.status === 429) {
        return Response.json(
          { error: 'rate_limited', provider: 'pyth' },
          { status: 503, headers: { 'retry-after': '30' } },
        );
      }
      return Response.json({ error: 'upstream_failed', provider: 'pyth' }, { status: 502 });
    }
    return Response.json({ error: 'upstream_failed' }, { status: 502 });
  }
}
