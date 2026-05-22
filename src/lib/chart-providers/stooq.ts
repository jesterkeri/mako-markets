// ----------------------------------------------------------------------------
// src/lib/chart-providers/stooq.ts
//
// Stooq daily OHLC CSV fetcher for COMMODITIES (XAU/XAG/XPT).
//
// Stooq is a free public market-data service. No API key, no
// signup, no per-account rate limit (though courtesy throttling
// applies — see KNOWN OPERATIONAL RISKs in the plan).
//
// Endpoint: GET https://stooq.com/q/d/l/?s=<symbol>&i=d
//   Response: CSV
//     Date,Open,High,Low,Close,Volume
//     2026-05-22,3402.5,3415.3,3398.1,3410.8,0
//     ...
//
// Date column is UTC midnight (Stooq is daily-only for this
// surface; intraday isn't free).
//
// Plan: %TEMP%/mako-166-charts-plan.md
// Memory: [[mako-charts]]
// ----------------------------------------------------------------------------

import 'server-only';
import type { Candle } from '@/types/chart';

export class StooqApiError extends Error {
  constructor(msg = 'stooq error') { super(msg); this.name = 'StooqApiError'; }
}

const EXPECTED_HEADER = 'Date,Open,High,Low,Close,Volume';

export async function fetchStooqDailyCandles(args: {
  providerSymbol: string;
  limit?: number;
}): Promise<Candle[]> {
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(args.providerSymbol)}&i=d`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new StooqApiError(`status ${res.status}`);

  const text = await res.text();
  const trimmed = text.trim();
  if (!trimmed || trimmed === 'No data') {
    throw new StooqApiError(`no data for ${args.providerSymbol}`);
  }

  const lines = trimmed.split('\n');
  // Trim any trailing \r from CRLF endings before comparing.
  const header = lines[0].replace(/\r$/, '');
  if (header !== EXPECTED_HEADER) {
    // When Stooq is throttling / blocking it returns an HTML error
    // page rather than CSV. The header check catches that cleanly.
    throw new StooqApiError('unexpected CSV header (possibly throttled)');
  }

  const candles: Candle[] = [];
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].replace(/\r$/, '');
    if (!row) continue;
    const [date, open, high, low, close, volume] = row.split(',');
    if (!date) continue;
    const t = new Date(date + 'T00:00:00Z').getTime();
    if (!Number.isFinite(t)) continue;
    // Skip rows where any OHLC value isn't a finite number. Stooq
    // occasionally returns rows with empty / 'N/A' fields when a
    // session was missing data; pushing NaN candles would break
    // lightweight-charts downstream. Empty-string check is
    // separate because `Number('')` is 0 (finite, but wrong).
    if (!open || !high || !low || !close) continue;
    const o = Number(open);
    const h = Number(high);
    const l = Number(low);
    const c = Number(close);
    if (!Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c)) {
      continue;
    }
    candles.push({
      timestamp: t,
      open:   o,
      high:   h,
      low:    l,
      close:  c,
      volume: Number(volume) || 0,
    });
  }

  const limit = args.limit ?? 200;
  return candles.slice(-limit);
}
