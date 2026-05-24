// ----------------------------------------------------------------------------
// src/lib/chart-providers/twelvedata.ts
//
// TwelveData historical OHLC fetcher for CRYPTO + FOREX + STOCKS.
// Commodities are NOT here — TwelveData's free Basic tier does not
// include precious metals. See `./stooq.ts`.
//
// Free tier: 8 req/min, 800/day, single API key per account.
// Requires `TWELVEDATA_API_KEY` env var (server-side only).
//
// Endpoint: GET https://api.twelvedata.com/time_series?symbol=…
//                &interval=…&outputsize=…&timezone=UTC&apikey=…
//
// `timezone=UTC` is explicit because TwelveData's per-class
// defaults differ (crypto=UTC, forex=Australia/Sydney, stocks=
// local-exchange). Forcing UTC normalizes timestamps across all
// asset classes.
//
// Plan: %TEMP%/mako-166-charts-plan.md
// Memory: [[mako-charts]]
// ----------------------------------------------------------------------------

import 'server-only';
import { z } from 'zod';
import type { Candle, Timeframe } from '@/types/chart';

const TimeSeriesResponse = z.object({
  values: z.array(
    z.object({
      datetime: z.string(),
      open: z.string(),
      high: z.string(),
      low: z.string(),
      close: z.string(),
      volume: z.string().optional(),
    }),
  ),
  status: z.literal('ok'),
});

const TF_TO_INTERVAL: Record<Timeframe, string> = {
  '15m': '15min',
  '1h':  '1h',
  '2h':  '2h',
  '4h':  '4h',
  '1d':  '1day',
};

export class TwelveDataRateLimitError extends Error {
  constructor(msg = 'rate limited') { super(msg); this.name = 'TwelveDataRateLimitError'; }
}
export class TwelveDataApiError extends Error {
  constructor(msg = 'api error') { super(msg); this.name = 'TwelveDataApiError'; }
}

export async function fetchTwelveDataCandles(args: {
  providerSymbol: string;
  timeframe: Timeframe;
  outputsize?: number;
}): Promise<Candle[]> {
  const apiKey = process.env.TWELVEDATA_API_KEY;
  if (!apiKey) throw new TwelveDataApiError('TWELVEDATA_API_KEY not set');

  const url = new URL('https://api.twelvedata.com/time_series');
  url.searchParams.set('symbol', args.providerSymbol);
  url.searchParams.set('interval', TF_TO_INTERVAL[args.timeframe]);
  // TwelveData Basic free tier permits up to 5000 candles per request.
  // Bump default from 200 → 1500 so the chart shows meaningful
  // history (~62 days of 1h, ~4y of 1d). Each upstream call costs
  // the same regardless of outputsize within the cap.
  url.searchParams.set('outputsize', String(args.outputsize ?? 1500));
  url.searchParams.set('timezone', 'UTC');
  url.searchParams.set('apikey', apiKey);

  const res = await fetch(url, { cache: 'no-store' });
  if (res.status === 429) throw new TwelveDataRateLimitError();
  if (!res.ok) throw new TwelveDataApiError(`status ${res.status}`);

  const json = (await res.json()) as Record<string, unknown>;
  if (json.status === 'error') {
    const msg = typeof json.message === 'string' ? json.message : 'unknown error';
    if (json.code === 429) throw new TwelveDataRateLimitError(msg);
    throw new TwelveDataApiError(msg);
  }

  const parsed = TimeSeriesResponse.parse(json);
  return parsed.values
    .map((v) => ({
      timestamp: parseTwelveDataDatetime(v.datetime),
      open:   Number(v.open),
      high:   Number(v.high),
      low:    Number(v.low),
      close:  Number(v.close),
      volume: v.volume ? Number(v.volume) : 0,
    }))
    .reverse(); // newest-first → ascending for lightweight-charts
}

/**
 * Parse a TwelveData `datetime` field into ms-since-epoch (UTC).
 *
 * With `timezone=UTC` the API returns either:
 *   - Intraday: "YYYY-MM-DD HH:MM:SS" → make it ISO 8601 with 'T'
 *     separator + 'Z' suffix
 *   - Daily:    "YYYY-MM-DD"          → append explicit midnight
 *
 * The daily branch is essential: `new Date('2026-05-22Z')` is a
 * non-standard string and parsing is implementation-defined (some
 * engines treat it as NaN). Always emit a fully-qualified ISO 8601
 * string with a literal 'T00:00:00' for daily values.
 */
function parseTwelveDataDatetime(s: string): number {
  if (s.includes(' ')) {
    return new Date(s.replace(' ', 'T') + 'Z').getTime();
  }
  return new Date(s + 'T00:00:00Z').getTime();
}
