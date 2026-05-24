// ----------------------------------------------------------------------------
// src/lib/chart-symbols.ts
//
// Dual-symbol allowlist for `/api/charts`. Each entry pairs:
//   - `oracleSymbol`: the canonical on-chain form (matches the first
//     segment of v4 `oracleRef`, `SYMBOL:gt|lt:STRIKE`). ALL CAPS,
//     no separator. Examples: 'BTC', 'EURUSD', 'XAUUSD', 'AAPL'.
//   - `providerSymbol`: the form TwelveData / Stooq expects.
//     TwelveData wants 'BTC/USD' / 'EUR/USD' / bare 'AAPL'. Stooq
//     wants lowercase 'xauusd' / 'xagusd' / 'xptusd'.
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
  // Aligned with src/lib/crypto-assets.ts:43-54 (MON excluded — no
  // historical feed for the Monad token on any free provider).
  // TwelveData accepts 'BTC/USD' style for crypto.
  { oracleSymbol: 'BTC',  providerSymbol: 'BTC/USD',  assetClass: 'CRYPTO' },
  { oracleSymbol: 'ETH',  providerSymbol: 'ETH/USD',  assetClass: 'CRYPTO' },
  { oracleSymbol: 'SOL',  providerSymbol: 'SOL/USD',  assetClass: 'CRYPTO' },
  { oracleSymbol: 'AVAX', providerSymbol: 'AVAX/USD', assetClass: 'CRYPTO' },
  { oracleSymbol: 'NEAR', providerSymbol: 'NEAR/USD', assetClass: 'CRYPTO' },
  { oracleSymbol: 'APT',  providerSymbol: 'APT/USD',  assetClass: 'CRYPTO' },
  { oracleSymbol: 'SUI',  providerSymbol: 'SUI/USD',  assetClass: 'CRYPTO' },
  { oracleSymbol: 'DOGE', providerSymbol: 'DOGE/USD', assetClass: 'CRYPTO' },
  { oracleSymbol: 'LINK', providerSymbol: 'LINK/USD', assetClass: 'CRYPTO' },

  // ── FOREX (10) ──────────────────────────────────────────────────
  // Verified against price-feed-assets.ts:79-88.
  { oracleSymbol: 'EURUSD', providerSymbol: 'EUR/USD', assetClass: 'FOREX' },
  { oracleSymbol: 'USDJPY', providerSymbol: 'USD/JPY', assetClass: 'FOREX' },
  { oracleSymbol: 'GBPUSD', providerSymbol: 'GBP/USD', assetClass: 'FOREX' },
  { oracleSymbol: 'AUDUSD', providerSymbol: 'AUD/USD', assetClass: 'FOREX' },
  { oracleSymbol: 'USDCAD', providerSymbol: 'USD/CAD', assetClass: 'FOREX' },
  { oracleSymbol: 'USDCHF', providerSymbol: 'USD/CHF', assetClass: 'FOREX' },
  { oracleSymbol: 'NZDUSD', providerSymbol: 'NZD/USD', assetClass: 'FOREX' },
  { oracleSymbol: 'EURGBP', providerSymbol: 'EUR/GBP', assetClass: 'FOREX' },
  { oracleSymbol: 'EURJPY', providerSymbol: 'EUR/JPY', assetClass: 'FOREX' },
  { oracleSymbol: 'GBPJPY', providerSymbol: 'GBP/JPY', assetClass: 'FOREX' },

  // ── COMMODITIES (3) ─────────────────────────────────────────────
  // Verified against price-feed-assets.ts:95-97. Yahoo Finance maps
  // spot precious metals → COMEX futures: gold = GC=F, silver = SI=F,
  // platinum = PL=F. (Switched from Stooq in #166 polish r5 — Stooq
  // added API-key auth to their free CSV endpoint.) Spot-on-spot
  // delta vs futures is small and the chart is illustrative anyway.
  { oracleSymbol: 'XAUUSD', providerSymbol: 'GC=F', assetClass: 'COMMODITIES' },
  { oracleSymbol: 'XAGUSD', providerSymbol: 'SI=F', assetClass: 'COMMODITIES' },
  { oracleSymbol: 'XPTUSD', providerSymbol: 'PL=F', assetClass: 'COMMODITIES' },

  // ── STOCKS (20) ─────────────────────────────────────────────────
  // Verified against price-feed-assets.ts:103-122. Oracle === provider
  // (bare US tickers). Mako's stock allowlist does NOT include
  // Berkshire (no BRK.A / BRK.B).
  { oracleSymbol: 'AAPL',  providerSymbol: 'AAPL',  assetClass: 'STOCKS' },
  { oracleSymbol: 'MSFT',  providerSymbol: 'MSFT',  assetClass: 'STOCKS' },
  { oracleSymbol: 'NVDA',  providerSymbol: 'NVDA',  assetClass: 'STOCKS' },
  { oracleSymbol: 'GOOGL', providerSymbol: 'GOOGL', assetClass: 'STOCKS' },
  { oracleSymbol: 'AMZN',  providerSymbol: 'AMZN',  assetClass: 'STOCKS' },
  { oracleSymbol: 'META',  providerSymbol: 'META',  assetClass: 'STOCKS' },
  { oracleSymbol: 'TSLA',  providerSymbol: 'TSLA',  assetClass: 'STOCKS' },
  { oracleSymbol: 'NFLX',  providerSymbol: 'NFLX',  assetClass: 'STOCKS' },
  { oracleSymbol: 'AMD',   providerSymbol: 'AMD',   assetClass: 'STOCKS' },
  { oracleSymbol: 'INTC',  providerSymbol: 'INTC',  assetClass: 'STOCKS' },
  { oracleSymbol: 'JPM',   providerSymbol: 'JPM',   assetClass: 'STOCKS' },
  { oracleSymbol: 'BAC',   providerSymbol: 'BAC',   assetClass: 'STOCKS' },
  { oracleSymbol: 'V',     providerSymbol: 'V',     assetClass: 'STOCKS' },
  { oracleSymbol: 'MA',    providerSymbol: 'MA',    assetClass: 'STOCKS' },
  { oracleSymbol: 'WMT',   providerSymbol: 'WMT',   assetClass: 'STOCKS' },
  { oracleSymbol: 'DIS',   providerSymbol: 'DIS',   assetClass: 'STOCKS' },
  { oracleSymbol: 'KO',    providerSymbol: 'KO',    assetClass: 'STOCKS' },
  { oracleSymbol: 'PEP',   providerSymbol: 'PEP',   assetClass: 'STOCKS' },
  { oracleSymbol: 'BA',    providerSymbol: 'BA',    assetClass: 'STOCKS' },
  { oracleSymbol: 'GS',    providerSymbol: 'GS',    assetClass: 'STOCKS' },
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
