// ----------------------------------------------------------------------------
// src/lib/chart-providers/yahoo.ts
//
// Yahoo Finance v8 chart-API fetcher for COMMODITIES (XAU / XAG /
// XPT, mapped to COMEX futures GC=F / SI=F / PL=F).
//
// Replaced Stooq in #166 polish r5 — Stooq added API-key gating to
// their previously-free CSV endpoint, so requests now return a
// "get your apikey" message instead of OHLC data. Yahoo's v8 chart
// endpoint is free, requires no key, and unlocks 15m + 1h intraday
// for precious metals (Stooq was daily-only on the free tier).
//
// Endpoint:
//   GET https://query1.finance.yahoo.com/v8/finance/chart/<symbol>
//       ?interval=<15m|60m|1d>&range=<5d|1mo|1y>
//
// Response shape:
//   {
//     chart: { result: [{
//       meta: {...},
//       timestamp: [epochSeconds, ...],
//       indicators: {
//         quote: [{ open: [..], high: [..], low: [..], close: [..], volume: [..] }]
//       }
//     }] }
//   }
//
// Yahoo intervals: 1m, 2m, 5m, 15m, 30m, 60m, 90m, 1h, 1d, 5d, 1wk,
// 1mo, 3mo. Note that 2h and 4h are NOT supported natively, so the
// MarketChart TIMEFRAMES_BY_CLASS gate excludes them for commodities.
// User-Agent header is required to avoid the public bot-filter.
// ----------------------------------------------------------------------------

import 'server-only';
import type { Candle, Timeframe } from '@/types/chart';

export class YahooApiError extends Error {
  constructor(msg = 'yahoo error') { super(msg); this.name = 'YahooApiError'; }
}

// Mako timeframe → Yahoo interval. Only the three supported values
// are present; 2h/4h are filtered out one level up.
const TF_TO_INTERVAL: Partial<Record<Timeframe, string>> = {
  '15m': '15m',
  '1h':  '60m',
  '1d':  '1d',
};

// Calibrated range per interval — Yahoo enforces interval × range
// combinations. Sized to give the user meaningful history (matches
// the TwelveData outputsize=1500 bump).
const TF_TO_RANGE: Partial<Record<Timeframe, string>> = {
  '15m': '1mo',   // ~2800 bars
  '1h':  '3mo',   // ~1080 bars (Yahoo 60m caps at 730d, well within)
  '1d':  '2y',    // ~520 bars
};

export async function fetchYahooCandles(args: {
  providerSymbol: string;
  timeframe: Timeframe;
  limit?: number;
}): Promise<Candle[]> {
  const interval = TF_TO_INTERVAL[args.timeframe];
  const range = TF_TO_RANGE[args.timeframe];
  if (!interval || !range) {
    throw new YahooApiError(`unsupported timeframe ${args.timeframe}`);
  }

  // Try query1 then query2 (different Yahoo edges; one may be blocked
  // by region or under load even when the other works).
  const path = `/v8/finance/chart/${encodeURIComponent(args.providerSymbol)}?interval=${interval}&range=${range}`;
  const hosts = [
    'https://query1.finance.yahoo.com',
    'https://query2.finance.yahoo.com',
  ];

  let res: Response | null = null;
  let lastErr: string = '';
  for (const host of hosts) {
    try {
      res = await fetch(host + path, {
        cache: 'no-store',
        headers: {
          // Yahoo blocks unknown user-agents on public endpoints. Any
          // browser-like UA passes.
          'user-agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
            'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
          'accept': 'application/json',
        },
      });
      if (res.ok) break;
      lastErr = `${host}: HTTP ${res.status}`;
      res = null;
    } catch (e) {
      lastErr = `${host}: ${(e as Error).message}`;
      res = null;
    }
  }

  if (!res) {
    throw new YahooApiError(lastErr || 'all yahoo hosts failed');
  }

  const json = (await res.json()) as {
    chart?: {
      result?: Array<{
        timestamp?: number[];
        indicators?: {
          quote?: Array<{
            open?: Array<number | null>;
            high?: Array<number | null>;
            low?: Array<number | null>;
            close?: Array<number | null>;
            volume?: Array<number | null>;
          }>;
        };
      }>;
      error?: { code?: string; description?: string } | null;
    };
  };

  if (json.chart?.error) {
    throw new YahooApiError(
      json.chart.error.description ?? json.chart.error.code ?? 'yahoo error',
    );
  }
  const result = json.chart?.result?.[0];
  const stamps = result?.timestamp;
  const quote = result?.indicators?.quote?.[0];
  if (!stamps || !quote) throw new YahooApiError('empty response shape');

  const opens = quote.open ?? [];
  const highs = quote.high ?? [];
  const lows = quote.low ?? [];
  const closes = quote.close ?? [];
  const volumes = quote.volume ?? [];

  const candles: Candle[] = [];
  for (let i = 0; i < stamps.length; i++) {
    const ts = stamps[i];
    const o = opens[i], h = highs[i], l = lows[i], c = closes[i];
    // Yahoo returns null for sessions where a bar didn't trade.
    // Skip those rather than push NaN-bearing candles.
    if (
      !Number.isFinite(ts) ||
      o == null || h == null || l == null || c == null ||
      !Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c)
    ) {
      continue;
    }
    candles.push({
      timestamp: ts * 1000, // Yahoo seconds → ms (krait Candle convention)
      open:   o,
      high:   h,
      low:    l,
      close:  c,
      volume: Number(volumes[i]) || 0,
    });
  }

  const limit = args.limit ?? 200;
  return candles.slice(-limit);
}
