// ----------------------------------------------------------------------------
// src/types/chart.ts
//
// Shared chart types. `Candle` matches krait's
// `apps/web/src/types/chart.ts:1-8` byte for byte so the ported
// `ChartInner` (Slice 5) compiles unchanged. `Timeframe` is
// mako-specific: lowercase string-literal union that maps cleanly
// onto Pyth Benchmarks' TradingView `resolution` param (15 / 60 /
// 120 / 240 / D) and the UI button labels.
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
   *  stocks). Pyth Benchmarks omits `v` for non-volume feeds; we
   *  normalize to 0 in the fetcher. */
  volume: number;
}

/** Mako chart timeframes. Subset of krait's superset; maps onto
 *  Pyth Benchmarks resolutions (15 / 60 / 120 / 240 / D).
 *  `2h` added in the polish pass after Joshua's Preview smoke. */
export type Timeframe = '15m' | '1h' | '2h' | '4h' | '1d';
