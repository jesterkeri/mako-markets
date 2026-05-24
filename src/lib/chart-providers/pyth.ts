// ----------------------------------------------------------------------------
// src/lib/chart-providers/pyth.ts
//
// Pyth Benchmarks TradingView shim — free, no key, region-stable
// (served from a global CDN). Same source as the cf-worker
// resolver so the chart matches what the market settles against.
// Returns proper OHLC candles for:
//   - Crypto.<SYMBOL>/USD
//   - FX.<BASE>/<QUOTE>
//   - Metal.<SYMBOL>/USD
//   - Equity.US.<TICKER>/USD
//
// Endpoint:
//   GET https://benchmarks.pyth.network/v1/shims/tradingview/history
//       ?symbol=<full>&resolution=<tvRes>&from=<sec>&to=<sec>
//
// Response:
//   { s: 'ok' | 'no_data' | 'error',
//     t: number[], o: number[], h: number[], l: number[], c: number[], v: number[] }
//
// Resolutions: 1, 5, 15, 30, 60, 120, 240 (minutes) | D | W | M
// ----------------------------------------------------------------------------

import 'server-only';
import type { Candle, Timeframe } from '@/types/chart';

export class PythApiError extends Error {
  status?: number;
  constructor(msg = 'pyth error', status?: number) {
    super(msg);
    this.name = 'PythApiError';
    this.status = status;
  }
}

const ENDPOINT = 'https://benchmarks.pyth.network/v1/shims/tradingview/history';

const TF_TO_RESOLUTION: Record<Timeframe, string> = {
  '15m': '15',
  '1h':  '60',
  '2h':  '120',
  '4h':  '240',
  '1d':  'D',
};

// Approximate seconds-per-candle, used to pick a `from` that yields
// ~1500 candles regardless of timeframe — the history depth the
// chart UI expects.
const TF_TO_SECONDS: Record<Timeframe, number> = {
  '15m': 15 * 60,
  '1h':  60 * 60,
  '2h':  120 * 60,
  '4h':  240 * 60,
  '1d':  24 * 60 * 60,
};

const TARGET_BARS = 1500;

interface PythHistoryResponse {
  s: 'ok' | 'no_data' | 'error';
  t?: number[];
  o?: number[];
  h?: number[];
  l?: number[];
  c?: number[];
  v?: number[];
  errmsg?: string;
}

export async function fetchPythCandles(args: {
  providerSymbol: string;   // e.g. 'Metal.XAU/USD', 'FX.EUR/USD', 'Crypto.BTC/USD', 'Equity.US.AAPL/USD'
  timeframe: Timeframe;
  limit?: number;
}): Promise<Candle[]> {
  const resolution = TF_TO_RESOLUTION[args.timeframe];
  const stepSec = TF_TO_SECONDS[args.timeframe];
  if (!resolution || !stepSec) {
    throw new PythApiError(`unsupported timeframe ${args.timeframe}`);
  }

  const limit = args.limit ?? TARGET_BARS;
  const to = Math.floor(Date.now() / 1000);
  // Pull ~2x the target so weekend/off-hour gaps don't shrink the
  // returned bar count below what the user expects.
  const from = to - stepSec * limit * 2;

  const url = new URL(ENDPOINT);
  url.searchParams.set('symbol', args.providerSymbol);
  url.searchParams.set('resolution', resolution);
  url.searchParams.set('from', String(from));
  url.searchParams.set('to', String(to));

  const res = await fetch(url.toString(), { cache: 'no-store' });
  if (!res.ok) throw new PythApiError(`status ${res.status}`, res.status);

  const json = (await res.json()) as PythHistoryResponse;
  if (json.s === 'error') {
    throw new PythApiError(json.errmsg ?? 'pyth error');
  }
  if (json.s === 'no_data' || !json.t || !json.o || !json.h || !json.l || !json.c) {
    return [];
  }

  const out: Candle[] = [];
  const len = Math.min(json.t.length, json.o.length, json.h.length, json.l.length, json.c.length);
  for (let i = 0; i < len; i++) {
    const ts = json.t[i];
    const o = json.o[i], h = json.h[i], l = json.l[i], c = json.c[i];
    if (
      !Number.isFinite(ts) ||
      !Number.isFinite(o) || !Number.isFinite(h) ||
      !Number.isFinite(l) || !Number.isFinite(c)
    ) {
      continue;
    }
    out.push({
      timestamp: ts * 1000,   // Pyth seconds → ms (krait Candle convention)
      open: o, high: h, low: l, close: c,
      volume: Number(json.v?.[i]) || 0,
    });
  }
  return out.slice(-limit);
}
