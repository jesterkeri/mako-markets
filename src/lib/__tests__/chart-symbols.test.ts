import { describe, expect, it } from 'vitest';

import {
  CHART_SYMBOLS,
  getChartSymbolByOracle,
} from '../chart-symbols';
import { PRICE_FEED_ASSETS } from '../price-feed-assets';

describe('chart-symbols', () => {
  describe('getChartSymbolByOracle', () => {
    it('returns CRYPTO entry for BTC', () => {
      const e = getChartSymbolByOracle('BTC');
      expect(e).toEqual({
        oracleSymbol: 'BTC',
        providerSymbol: 'BTC/USD',
        assetClass: 'CRYPTO',
      });
    });

    it('returns FOREX entry for EURUSD', () => {
      const e = getChartSymbolByOracle('EURUSD');
      expect(e).toEqual({
        oracleSymbol: 'EURUSD',
        providerSymbol: 'EUR/USD',
        assetClass: 'FOREX',
      });
    });

    it('returns COMMODITIES entry for XAUUSD', () => {
      const e = getChartSymbolByOracle('XAUUSD');
      expect(e).toEqual({
        oracleSymbol: 'XAUUSD',
        providerSymbol: 'xauusd',
        assetClass: 'COMMODITIES',
      });
    });

    it('returns STOCKS entry for AAPL', () => {
      const e = getChartSymbolByOracle('AAPL');
      expect(e).toEqual({
        oracleSymbol: 'AAPL',
        providerSymbol: 'AAPL',
        assetClass: 'STOCKS',
      });
    });

    it('returns undefined for MON (excluded crypto)', () => {
      expect(getChartSymbolByOracle('MON')).toBeUndefined();
    });

    it('returns undefined for unknown ticker', () => {
      expect(getChartSymbolByOracle('NOT_REAL')).toBeUndefined();
    });

    it('is case-sensitive (lowercase btc misses)', () => {
      expect(getChartSymbolByOracle('btc')).toBeUndefined();
    });
  });

  describe('symbol-set counts', () => {
    it('has 9 CRYPTO, 10 FOREX, 3 COMMODITIES, 20 STOCKS', () => {
      const counts = { CRYPTO: 0, FOREX: 0, COMMODITIES: 0, STOCKS: 0 };
      for (const s of CHART_SYMBOLS) counts[s.assetClass]++;
      expect(counts).toEqual({
        CRYPTO: 9,
        FOREX: 10,
        COMMODITIES: 3,
        STOCKS: 20,
      });
    });

    it('total entries: 42', () => {
      expect(CHART_SYMBOLS.length).toBe(42);
    });
  });

  describe('drift guard (bidirectional set equality with price-feed-assets)', () => {
    // For FOREX/COMMODITIES/STOCKS only. CRYPTO is NOT cross-checked
    // because crypto-assets.ts is a separate allowlist serving a
    // different purpose (CoinGecko-based ticker resolution).
    const chartFCSSet = new Set(
      CHART_SYMBOLS.filter((s) => s.assetClass !== 'CRYPTO').map(
        (s) => s.oracleSymbol,
      ),
    );
    const priceFeedSet = new Set(PRICE_FEED_ASSETS.map((a) => a.symbol));

    it('every FOREX/COMMODITIES/STOCKS chart symbol exists in price-feed-assets', () => {
      for (const sym of chartFCSSet) {
        expect(priceFeedSet.has(sym), `chart symbol "${sym}" missing from price-feed-assets.ts`).toBe(true);
      }
    });

    it('every price-feed-assets symbol exists in chart symbols', () => {
      for (const sym of priceFeedSet) {
        expect(chartFCSSet.has(sym), `price-feed-assets symbol "${sym}" missing from chart-symbols.ts`).toBe(true);
      }
    });

    it('sets are equal in size', () => {
      expect(chartFCSSet.size).toBe(priceFeedSet.size);
    });
  });
});
