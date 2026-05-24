// ----------------------------------------------------------------------------
// src/lib/chart-symbols.ts
//
// Dual-symbol allowlist for `/api/charts`. Each entry pairs:
//   - `oracleSymbol`: the canonical on-chain form (matches the first
//     segment of v4 `oracleRef`, `SYMBOL:gt|lt:STRIKE`). ALL CAPS,
//     no separator. Examples: 'BTC', 'EURUSD', 'XAUUSD', 'AAPL'.
//   - `providerSymbol`: the form Pyth Benchmarks expects. Class
//     prefix + slash form: 'Crypto.BTC/USD', 'FX.EUR/USD',
//     'Metal.XAU/USD', 'Equity.US.AAPL/USD'.
//
// This module is INTENTIONALLY SEPARATE from
// `src/lib/price-feed-assets.ts`. price-feed-assets is the
// resolution-mirror used by sponsor / worker validation;
// chart-symbols is chart-fetcher-only. A `chartOnly` flag on a
// shared list would risk leaking CRYPTO Pyth-style entries into
// resolution paths. The drift-guard test below catches accidental
// divergence for FOREX/COMMODITIES/STOCKS.
//
// CRYPTO is NOT cross-checked against `crypto-assets.ts` because
// the two allowlists serve different purposes (charts vs ticker
// resolution). MON is excluded from charts because no external
// historical OHLC source covers Monad testnet.
//
// Plan: %TEMP%/mako-166-charts-plan.md
// Memory: [[mako-charts]]
// ----------------------------------------------------------------------------

export type ChartAssetClass = 'CRYPTO' | 'FOREX' | 'COMMODITIES' | 'STOCKS';

export type ChartSymbol = {
  oracleSymbol: string;
  providerSymbol: string;
  assetClass: ChartAssetClass;
};

export const CHART_SYMBOLS: readonly ChartSymbol[] = [
  // ── CRYPTO (9) ──────────────────────────────────────────────────
  // Pyth Benchmarks `Crypto.<SYM>/USD` form.
  { oracleSymbol: 'BTC',  providerSymbol: 'Crypto.BTC/USD',  assetClass: 'CRYPTO' },
  { oracleSymbol: 'ETH',  providerSymbol: 'Crypto.ETH/USD',  assetClass: 'CRYPTO' },
  { oracleSymbol: 'SOL',  providerSymbol: 'Crypto.SOL/USD',  assetClass: 'CRYPTO' },
  { oracleSymbol: 'AVAX', providerSymbol: 'Crypto.AVAX/USD', assetClass: 'CRYPTO' },
  { oracleSymbol: 'NEAR', providerSymbol: 'Crypto.NEAR/USD', assetClass: 'CRYPTO' },
  { oracleSymbol: 'APT',  providerSymbol: 'Crypto.APT/USD',  assetClass: 'CRYPTO' },
  { oracleSymbol: 'SUI',  providerSymbol: 'Crypto.SUI/USD',  assetClass: 'CRYPTO' },
  { oracleSymbol: 'DOGE', providerSymbol: 'Crypto.DOGE/USD', assetClass: 'CRYPTO' },
  { oracleSymbol: 'LINK', providerSymbol: 'Crypto.LINK/USD', assetClass: 'CRYPTO' },

  // ── FOREX (10) ──────────────────────────────────────────────────
  // Pyth Benchmarks `FX.<BASE>/<QUOTE>` form.
  { oracleSymbol: 'EURUSD', providerSymbol: 'FX.EUR/USD', assetClass: 'FOREX' },
  { oracleSymbol: 'USDJPY', providerSymbol: 'FX.USD/JPY', assetClass: 'FOREX' },
  { oracleSymbol: 'GBPUSD', providerSymbol: 'FX.GBP/USD', assetClass: 'FOREX' },
  { oracleSymbol: 'AUDUSD', providerSymbol: 'FX.AUD/USD', assetClass: 'FOREX' },
  { oracleSymbol: 'USDCAD', providerSymbol: 'FX.USD/CAD', assetClass: 'FOREX' },
  { oracleSymbol: 'USDCHF', providerSymbol: 'FX.USD/CHF', assetClass: 'FOREX' },
  { oracleSymbol: 'NZDUSD', providerSymbol: 'FX.NZD/USD', assetClass: 'FOREX' },
  { oracleSymbol: 'EURGBP', providerSymbol: 'FX.EUR/GBP', assetClass: 'FOREX' },
  { oracleSymbol: 'EURJPY', providerSymbol: 'FX.EUR/JPY', assetClass: 'FOREX' },
  { oracleSymbol: 'GBPJPY', providerSymbol: 'FX.GBP/JPY', assetClass: 'FOREX' },

  // ── COMMODITIES (3) ─────────────────────────────────────────────
  // Pyth Benchmarks `Metal.<SYM>/USD` form.
  { oracleSymbol: 'XAUUSD', providerSymbol: 'Metal.XAU/USD', assetClass: 'COMMODITIES' },
  { oracleSymbol: 'XAGUSD', providerSymbol: 'Metal.XAG/USD', assetClass: 'COMMODITIES' },
  { oracleSymbol: 'XPTUSD', providerSymbol: 'Metal.XPT/USD', assetClass: 'COMMODITIES' },

  // ── STOCKS (20) ─────────────────────────────────────────────────
  // Pyth Benchmarks `Equity.US.<TICKER>/USD` form.
  { oracleSymbol: 'AAPL',  providerSymbol: 'Equity.US.AAPL/USD',  assetClass: 'STOCKS' },
  { oracleSymbol: 'MSFT',  providerSymbol: 'Equity.US.MSFT/USD',  assetClass: 'STOCKS' },
  { oracleSymbol: 'NVDA',  providerSymbol: 'Equity.US.NVDA/USD',  assetClass: 'STOCKS' },
  { oracleSymbol: 'GOOGL', providerSymbol: 'Equity.US.GOOGL/USD', assetClass: 'STOCKS' },
  { oracleSymbol: 'AMZN',  providerSymbol: 'Equity.US.AMZN/USD',  assetClass: 'STOCKS' },
  { oracleSymbol: 'META',  providerSymbol: 'Equity.US.META/USD',  assetClass: 'STOCKS' },
  { oracleSymbol: 'TSLA',  providerSymbol: 'Equity.US.TSLA/USD',  assetClass: 'STOCKS' },
  { oracleSymbol: 'NFLX',  providerSymbol: 'Equity.US.NFLX/USD',  assetClass: 'STOCKS' },
  { oracleSymbol: 'AMD',   providerSymbol: 'Equity.US.AMD/USD',   assetClass: 'STOCKS' },
  { oracleSymbol: 'INTC',  providerSymbol: 'Equity.US.INTC/USD',  assetClass: 'STOCKS' },
  { oracleSymbol: 'JPM',   providerSymbol: 'Equity.US.JPM/USD',   assetClass: 'STOCKS' },
  { oracleSymbol: 'BAC',   providerSymbol: 'Equity.US.BAC/USD',   assetClass: 'STOCKS' },
  { oracleSymbol: 'V',     providerSymbol: 'Equity.US.V/USD',     assetClass: 'STOCKS' },
  { oracleSymbol: 'MA',    providerSymbol: 'Equity.US.MA/USD',    assetClass: 'STOCKS' },
  { oracleSymbol: 'WMT',   providerSymbol: 'Equity.US.WMT/USD',   assetClass: 'STOCKS' },
  { oracleSymbol: 'DIS',   providerSymbol: 'Equity.US.DIS/USD',   assetClass: 'STOCKS' },
  { oracleSymbol: 'KO',    providerSymbol: 'Equity.US.KO/USD',    assetClass: 'STOCKS' },
  { oracleSymbol: 'PEP',   providerSymbol: 'Equity.US.PEP/USD',   assetClass: 'STOCKS' },
  { oracleSymbol: 'BA',    providerSymbol: 'Equity.US.BA/USD',    assetClass: 'STOCKS' },
  { oracleSymbol: 'GS',    providerSymbol: 'Equity.US.GS/USD',    assetClass: 'STOCKS' },
] as const;

const BY_ORACLE: ReadonlyMap<string, ChartSymbol> = new Map(
  CHART_SYMBOLS.map((s) => [s.oracleSymbol, s]),
);

/** Lookup by the canonical on-chain symbol form. Case-sensitive —
 *  caller must `toUpperCase()` first. */
export function getChartSymbolByOracle(
  oracleSymbol: string,
): ChartSymbol | undefined {
  return BY_ORACLE.get(oracleSymbol);
}
