// ----------------------------------------------------------------------------
// src/app/api/charts/route.ts
//
// Public chart-data endpoint. GET /api/charts?s=BTC&tf=1h
//
// Query schema (zod):
//   - s: oracleSymbol (canonical on-chain form, case-insensitive)
//   - tf: '15m' | '1h' | '4h' | '1d' (default '1h')
//
// Responses:
//   200 { candles: Candle[] }
//   400 { error: 'bad_params' | 'timeframe_not_supported' }
//   404 { error: 'unknown_symbol' }
//   502 { error: 'upstream_failed', provider?: 'stooq' }
//   503 { error: 'rate_limited' }                  // TwelveData 429
//
// Asset-class routing (exhaustive switch with `assertNever`):
//   CRYPTO / FOREX / STOCKS → TwelveData
//   COMMODITIES             → Stooq (daily-only; tf=1d required)
//
// Server-side cache: Next 16 `unstable_cache` keyed by
// [providerSymbol, tf] with tiered TTL so the daily budget fits
// within TwelveData's 8 req/min free-tier ceiling. See plan
// rate-limit budget table.
//
// KNOWN OPERATIONAL RISKS (documented in plan, accepted for v1):
//   - Cache stampede on TTL expiry (concurrent misses hit upstream)
//   - Daily-cap exhaustion under sustained scraper traffic
//
// Plan: %TEMP%/mako-166-charts-plan.md
// Memory: [[mako-charts]]
// ----------------------------------------------------------------------------

import { NextRequest } from 'next/server';
import { unstable_cache } from 'next/cache';
import { z } from 'zod';

import { getChartSymbolByOracle } from '@/lib/chart-symbols';
import {
  fetchTwelveDataCandles,
  TwelveDataRateLimitError,
  TwelveDataApiError,
} from '@/lib/chart-providers/twelvedata';
import {
  fetchStooqDailyCandles,
  StooqApiError,
} from '@/lib/chart-providers/stooq';
import type { Timeframe } from '@/types/chart';

const Query = z.object({
  s:  z.string().min(1).max(20),
  tf: z.enum(['15m', '1h', '4h', '1d']).default('1h'),
});

const TTL: Record<Timeframe, number> = {
  '15m':  120,
  '1h':   300,
  '4h':   600,
  '1d':  1800,
};

function assertNever(x: never): never {
  throw new Error(`unhandled asset class: ${String(x)}`);
}

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

  // Commodities are daily-only (Stooq has no intraday). Reject
  // non-1d up front so we never burn a cache slot or upstream call
  // on an impossible timeframe.
  if (entry.assetClass === 'COMMODITIES' && tf !== '1d') {
    return Response.json({ error: 'timeframe_not_supported' }, { status: 400 });
  }

  const fetcher = unstable_cache(
    async () => {
      switch (entry.assetClass) {
        case 'CRYPTO':
        case 'FOREX':
        case 'STOCKS':
          return fetchTwelveDataCandles({
            providerSymbol: entry.providerSymbol,
            timeframe: tf,
          });
        case 'COMMODITIES':
          return fetchStooqDailyCandles({
            providerSymbol: entry.providerSymbol,
          });
        default:
          return assertNever(entry.assetClass);
      }
    },
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
    if (err instanceof TwelveDataRateLimitError) {
      return Response.json({ error: 'rate_limited' }, { status: 503 });
    }
    if (err instanceof StooqApiError) {
      return Response.json({ error: 'upstream_failed', provider: 'stooq' }, { status: 502 });
    }
    if (err instanceof TwelveDataApiError) {
      return Response.json({ error: 'upstream_failed', provider: 'twelvedata' }, { status: 502 });
    }
    return Response.json({ error: 'upstream_failed' }, { status: 502 });
  }
}
