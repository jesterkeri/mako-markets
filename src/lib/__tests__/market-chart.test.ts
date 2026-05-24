import { describe, expect, it } from 'vitest';

import { MarketType, type Market } from '../contract';
import { marketToChartConfig } from '../market-chart';
import { toBytes32 } from '../oracle';

function makeMarket(overrides: Partial<Market>): Pick<Market, 'mType' | 'oracleRef'> {
  return {
    mType: MarketType.CRYPTO,
    oracleRef: toBytes32('BTC:gt:50000'),
    ...overrides,
  };
}

describe('marketToChartConfig', () => {
  it('CRYPTO + BTC:gt:50000 → returns chart config', () => {
    const m = makeMarket({
      mType: MarketType.CRYPTO,
      oracleRef: toBytes32('BTC:gt:50000'),
    });
    expect(marketToChartConfig(m)).toEqual({
      oracleSymbol: 'BTC',
      providerSymbol: 'BTC/USD',
      assetClass: 'CRYPTO',
    });
  });

  it('FOREX + EURUSD:lt:1.10 → returns chart config', () => {
    const m = makeMarket({
      mType: MarketType.FOREX,
      oracleRef: toBytes32('EURUSD:lt:1.10'),
    });
    expect(marketToChartConfig(m)).toEqual({
      oracleSymbol: 'EURUSD',
      providerSymbol: 'EUR/USD',
      assetClass: 'FOREX',
    });
  });

  it('COMMODITIES + XAUUSD:gt:2000 → returns chart config', () => {
    const m = makeMarket({
      mType: MarketType.COMMODITIES,
      oracleRef: toBytes32('XAUUSD:gt:2000'),
    });
    expect(marketToChartConfig(m)).toEqual({
      oracleSymbol: 'XAUUSD',
      providerSymbol: 'GC=F',
      assetClass: 'COMMODITIES',
    });
  });

  it('STOCKS + AAPL:lt:200 → returns chart config', () => {
    const m = makeMarket({
      mType: MarketType.STOCKS,
      oracleRef: toBytes32('AAPL:lt:200'),
    });
    expect(marketToChartConfig(m)).toEqual({
      oracleSymbol: 'AAPL',
      providerSymbol: 'AAPL',
      assetClass: 'STOCKS',
    });
  });

  it('MAKO market → null', () => {
    const m = makeMarket({
      mType: MarketType.MAKO,
      oracleRef: toBytes32('BTC:gt:50000'),
    });
    expect(marketToChartConfig(m)).toBeNull();
  });

  it('FOOTBALL market → null', () => {
    const m = makeMarket({
      mType: MarketType.FOOTBALL,
      oracleRef: toBytes32('MUFC:gt:0'),
    });
    expect(marketToChartConfig(m)).toBeNull();
  });

  it('BASKETBALL market → null', () => {
    const m = makeMarket({
      mType: MarketType.BASKETBALL,
      oracleRef: toBytes32('LAL:gt:0'),
    });
    expect(marketToChartConfig(m)).toBeNull();
  });

  it('CRYPTO + MON:gt:1 → null (symbol not in chart allowlist)', () => {
    const m = makeMarket({
      mType: MarketType.CRYPTO,
      oracleRef: toBytes32('MON:gt:1'),
    });
    expect(marketToChartConfig(m)).toBeNull();
  });

  it('mType/class mismatch (CRYPTO + AAPL) → null', () => {
    const m = makeMarket({
      mType: MarketType.CRYPTO,
      oracleRef: toBytes32('AAPL:gt:200'),
    });
    expect(marketToChartConfig(m)).toBeNull();
  });

  it('empty oracleRef (32-byte zero) → null', () => {
    const m = makeMarket({
      mType: MarketType.CRYPTO,
      oracleRef: '0x0000000000000000000000000000000000000000000000000000000000000000',
    });
    expect(marketToChartConfig(m)).toBeNull();
  });

  it('oracleRef without colon → falls back to whole string', () => {
    // toBytes32('BTC') with no ':' suffix — split(':')[0] is 'BTC'
    const m = makeMarket({
      mType: MarketType.CRYPTO,
      oracleRef: toBytes32('BTC'),
    });
    expect(marketToChartConfig(m)).toEqual({
      oracleSymbol: 'BTC',
      providerSymbol: 'BTC/USD',
      assetClass: 'CRYPTO',
    });
  });

  it('lowercase symbol in oracleRef is canonicalized via toUpperCase', () => {
    // Create flow always uppercases (CreateClient normalizedSymbol),
    // but the decoder defends against legacy/buggy refs too.
    const m = makeMarket({
      mType: MarketType.CRYPTO,
      oracleRef: toBytes32('btc:gt:50000'),
    });
    expect(marketToChartConfig(m)).toEqual({
      oracleSymbol: 'BTC',
      providerSymbol: 'BTC/USD',
      assetClass: 'CRYPTO',
    });
  });
});
