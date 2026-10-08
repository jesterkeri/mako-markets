// ----------------------------------------------------------------------------
// src/lib/chart-providers/coinbase.ts
//
// Candles for the crypto price charts, from Coinbase Exchange's public candles endpoint (no key). Replaces Pyth
// Benchmarks, which has answered 404 on every path since 2026-09-29. A chart is a reference picture of the market, not
// a settlement input: pools settle on the resolver's price and rounds on Chainlink Data Streams.
//
// Coinbase serves 60 s, 5 min, 15 min, 1 h, 6 h and 1 d candles, at most 300 to 350 per request, newest first, each
// [time, low, high, open, close, volume]. It has no 2 h or 4 h candles, so those are built from 1 h ones.
// ----------------------------------------------------------------------------

import 'server-only';
import type { Candle, Timeframe } from '@/types/chart';

export class CoinbaseApiError extends Error {
  override name = 'CoinbaseApiError';
  constructor(
    msg: string,
    readonly status?: number,
  ) {
    super(msg);
  }
}

const ENDPOINT = 'https://api.exchange.coinbase.com/products';

/// Seconds a candle may start after this server's clock and still count as now: the still-forming candle must not be
/// refused because this clock runs a second behind Coinbase's.
const CLOCK_SLACK_S = 60;

/// The Coinbase granularity fetched for each timeframe, and how many of those make one candle.
const PLAN: Record<Timeframe, { granularity: number; per: number }> = {
  '1m': { granularity: 60, per: 1 },
  '15m': { granularity: 900, per: 1 },
  '1h': { granularity: 3600, per: 1 },
  '2h': { granularity: 3600, per: 2 },
  '4h': { granularity: 3600, per: 4 },
  '1d': { granularity: 86400, per: 1 },
};

/// Coinbase rows (newest first) as candles (oldest first), or a throw on any row that is not a real candle. A bad row
/// is an upstream fault, never something to draw: each candle must start on the `granularity` grid (so rows really are
/// candles of that size, which the 2h/4h buckets rely on) and no later than `nowSec`.
export function parseCoinbaseCandles(raw: unknown, granularity: number, nowSec: number): Candle[] {
  if (!Array.isArray(raw)) throw new CoinbaseApiError('answer is not a list');
  const out: Candle[] = [];
  let prevT = Infinity;
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 6 || !row.slice(0, 6).every((x) => typeof x === 'number' && Number.isFinite(x))) {
      throw new CoinbaseApiError('malformed candle');
    }
    const [t, low, high, open, close, volume] = row as number[];
    if (!Number.isInteger(t) || t <= 0 || t >= prevT) throw new CoinbaseApiError('candles out of order');
    if (t % granularity !== 0) throw new CoinbaseApiError('candle off its grid');
    if (t > nowSec + CLOCK_SLACK_S) throw new CoinbaseApiError('candle in the future');
    if (low <= 0 || low > Math.min(open, close) || high < Math.max(open, close) || volume < 0) {
      throw new CoinbaseApiError('impossible candle');
    }
    prevT = t;
    out.push({ timestamp: t * 1000, open, high, low, close, volume });
  }
  return out.reverse();
}

/// Joins candles into candles `per` times as long, aligned to UTC multiples of the longer span. A longer candle is made
/// only from base candles that are consecutive (each exactly `spanMs` after the last) and start at the bucket's start:
/// a bucket with a missing base candle (no trades that hour, or a gap in the answer) is left out, never drawn as one
/// continuous candle (Codex CHARTS r1 #1). Completed buckets need all `per` candles; the newest bucket, still forming,
/// may hold a contiguous prefix of them.
export function aggregateCandles(candles: readonly Candle[], spanMs: number, per: number): Candle[] {
  if (per === 1) return [...candles];
  const big = spanMs * per;
  const buckets: { start: number; n: number; contiguous: boolean; last: number; c: Candle }[] = [];
  for (const k of candles) {
    const start = Math.floor(k.timestamp / big) * big;
    const b = buckets[buckets.length - 1];
    if (b && b.start === start) {
      if (k.timestamp !== b.last + spanMs) b.contiguous = false;
      b.last = k.timestamp;
      b.n += 1;
      b.c = { ...b.c, high: Math.max(b.c.high, k.high), low: Math.min(b.c.low, k.low), close: k.close, volume: b.c.volume + k.volume };
    } else {
      buckets.push({ start, n: 1, contiguous: k.timestamp === start, last: k.timestamp, c: { ...k, timestamp: start } });
    }
  }
  return buckets
    .filter((b, i) => b.contiguous && (b.n === per || (i === buckets.length - 1 && b.n < per)))
    .map((b) => b.c);
}

export async function fetchCoinbaseCandles(args: { product: string; timeframe: Timeframe }): Promise<Candle[]> {
  const plan = PLAN[args.timeframe];
  if (!plan) throw new CoinbaseApiError(`unsupported timeframe ${args.timeframe}`);
  if (!/^[A-Z0-9]{2,10}-USD$/.test(args.product)) throw new CoinbaseApiError('bad product');
  const url = `${ENDPOINT}/${args.product}/candles?granularity=${plan.granularity}`;
  const res = await fetch(url, {
    cache: 'no-store',
    headers: { accept: 'application/json', 'user-agent': 'mako-market-charts' },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new CoinbaseApiError(`status ${res.status}`, res.status);
  const candles = parseCoinbaseCandles(await res.json(), plan.granularity, Math.floor(Date.now() / 1000));
  return aggregateCandles(candles, plan.granularity * 1000, plan.per);
}
