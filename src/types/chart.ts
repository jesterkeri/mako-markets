// ----------------------------------------------------------------------------
// src/types/chart.ts
//
// Shared chart types. `Candle` matches krait's
// `apps/web/src/types/chart.ts:1-8` byte for byte so the ported
// `ChartInner` (Slice 5) compiles unchanged. `Timeframe` is
// mako-specific: lowercase string-literal union that maps cleanly
// onto TwelveData's `interval` query param and the UI button labels.
//
// Plan: %TEMP%/mako-166-charts-plan.md
// Memory: [[mako-charts]]
// ----------------------------------------------------------------------------

export interface Candle {
  /** Milliseconds since epoch. NOT seconds — krait's ChartInner
   *  divides by 1000 when handing to lightweight-charts. */
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** 0 for asset classes without volume (FX, commodities, off-hours
   *  stocks). TwelveData returns no `volume` field for FX; we
   *  normalize to 0 in the fetcher. */
  volume: number;
}

/** Mako chart timeframes. Subset of krait's superset; chosen to
 *  fit the TwelveData free-tier rate-limit budget (8 req/min). */
export type Timeframe = '15m' | '1h' | '4h' | '1d';
