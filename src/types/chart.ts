// ----------------------------------------------------------------------------
// src/types/chart.ts
//
// Shared chart types. `Candle` matches krait's
// `apps/web/src/types/chart.ts:1-8` byte for byte so the ported
// `ChartInner` (Slice 5) compiles unchanged. `Timeframe` is
// mako-specific: lowercase string-literal union for the UI button labels.
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
  /** Traded volume in the base asset (Coinbase); 0 when a source has none. */
  volume: number;
}

/** Mako chart timeframes, served from Coinbase candles (`src/lib/chart-providers/coinbase.ts`; 2h and 4h are built
 *  from 1h). `1m` is the Rounds chart's live view. */
export type Timeframe = '1m' | '15m' | '1h' | '2h' | '4h' | '1d';
