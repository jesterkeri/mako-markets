// ----------------------------------------------------------------------------
// src/lib/market-chart.ts
//
// Decode a v4 Market into chart-eligibility config.
//
// Maps `Market.mType` (FOOTBALL=0, CRYPTO=1, BASKETBALL=2, FOREX=3,
// COMMODITIES=4, STOCKS=5, MAKO=6) → asset class. Decodes
// `Market.oracleRef` (bytes32 holding ASCII "SYMBOL:gt|lt:STRIKE") to
// extract the symbol, looks it up against `chart-symbols.ts`, and
// returns the dual-symbol + asset-class config OR null for any
// market that isn't chartable.
//
// Returns null for:
//   - Sports markets (FOOTBALL, BASKETBALL)
//   - Admin-curated MAKO markets
//   - Unknown oracle symbols (e.g. MON crypto markets)
//   - oracleRef that fails bytes32→string decoding
//   - Symbols whose oracle/class pairing doesn't match (defense
//     against a buggy market with mType=CRYPTO + symbol=AAPL)
//
// Plan: %TEMP%/mako-166-charts-plan.md
// Memory: [[mako-charts]]
// ----------------------------------------------------------------------------

import { hexToString } from 'viem';
import { MarketType, type Market } from './contract';
import { getChartSymbolByOracle, type ChartAssetClass } from './chart-symbols';

const MTYPE_TO_ASSET_CLASS: Partial<Record<MarketType, ChartAssetClass>> = {
  [MarketType.CRYPTO]:      'CRYPTO',
  [MarketType.FOREX]:       'FOREX',
  [MarketType.COMMODITIES]: 'COMMODITIES',
  [MarketType.STOCKS]:      'STOCKS',
  // FOOTBALL, BASKETBALL, MAKO intentionally absent → undefined → null.
};

export type ChartConfig = {
  oracleSymbol: string;
  providerSymbol: string;
  assetClass: ChartAssetClass;
};

export function marketToChartConfig(
  market: Pick<Market, 'mType' | 'oracleRef'>,
): ChartConfig | null {
  const assetClass = MTYPE_TO_ASSET_CLASS[market.mType];
  if (!assetClass) return null;

  let decoded: string;
  try {
    decoded = hexToString(market.oracleRef, { size: 32 });
  } catch {
    return null;
  }

  const oracleSymbol = decoded.split(':')[0]?.trim().toUpperCase();
  if (!oracleSymbol) return null;

  const entry = getChartSymbolByOracle(oracleSymbol);
  if (!entry) return null;

  // Sanity gate: a market with mType=CRYPTO but oracleRef "AAPL:gt:200"
  // is a contract-side bug — return null rather than rendering a stock
  // chart on a crypto market.
  if (entry.assetClass !== assetClass) return null;

  return {
    oracleSymbol: entry.oracleSymbol,
    providerSymbol: entry.providerSymbol,
    assetClass: entry.assetClass,
  };
}
