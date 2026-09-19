import feedStatus from './feed-status.json';

// Asset tables copied from the resolver and the feed map. A drift test
// (test/assets-drift.test.ts) compares them with cf-worker/src/price-feed-assets.ts
// and src/lib/crypto-assets.ts, so a change there fails CI until this copy
// follows.

/// MIRROR of the resolver's CRYPTO_SYMBOLS (cf-worker/src/index.ts L147).
export const CRYPTO_SYMBOLS: readonly string[] = ['BTC', 'ETH', 'SOL', 'AVAX', 'NEAR', 'APT', 'SUI', 'DOGE', 'LINK', 'MON'];

export type PriceFeedClass = 'forex' | 'commodities' | 'stocks';

/// MIRROR of PRICE_FEED_ASSETS symbol -> class (cf-worker/src/price-feed-assets.ts).
export const PRICE_FEED_CLASS: ReadonlyMap<string, PriceFeedClass> = new Map<string, PriceFeedClass>([
  ['EURUSD', 'forex'], ['USDJPY', 'forex'], ['GBPUSD', 'forex'], ['AUDUSD', 'forex'], ['USDCAD', 'forex'],
  ['USDCHF', 'forex'], ['NZDUSD', 'forex'], ['EURGBP', 'forex'], ['EURJPY', 'forex'], ['GBPJPY', 'forex'],
  ['XAUUSD', 'commodities'], ['XAGUSD', 'commodities'], ['XPTUSD', 'commodities'],
  ['AAPL', 'stocks'], ['MSFT', 'stocks'], ['NVDA', 'stocks'], ['GOOGL', 'stocks'], ['AMZN', 'stocks'],
  ['META', 'stocks'], ['TSLA', 'stocks'], ['NFLX', 'stocks'], ['AMD', 'stocks'], ['INTC', 'stocks'],
  ['JPM', 'stocks'], ['BAC', 'stocks'], ['V', 'stocks'], ['MA', 'stocks'], ['WMT', 'stocks'],
  ['DIS', 'stocks'], ['KO', 'stocks'], ['PEP', 'stocks'], ['BA', 'stocks'], ['GS', 'stocks'],
]);

/// Symbols with no verified Chainlink Data Streams feed on Monad testnet. The
/// status table is generated from mako-design's feed map by
/// scripts/gen-feed-status.mjs, which records the map's sha256; run it with
/// --check before committing. A new market on a paused symbol gets a creation
/// alert.
export const FEED_STATUS: Readonly<Record<string, 'verified' | 'paused'>> = feedStatus.symbols as Record<string, 'verified' | 'paused'>;
export const PAUSED_SYMBOLS: ReadonlySet<string> = new Set(Object.keys(FEED_STATUS).filter((s) => FEED_STATUS[s] === 'paused'));

export const MARKET_TYPE = {
  FOOTBALL: 0,
  CRYPTO: 1,
  BASKETBALL: 2,
  FOREX: 3,
  COMMODITIES: 4,
  STOCKS: 5,
  MAKO: 6,
} as const;

const TYPE_NAMES = ['FOOTBALL', 'CRYPTO', 'BASKETBALL', 'FOREX', 'COMMODITIES', 'STOCKS', 'MAKO'];

export function typeName(mType: number): string {
  return TYPE_NAMES[mType] ?? `TYPE${mType}`;
}

export function isPriceType(mType: number): boolean {
  return mType === MARKET_TYPE.CRYPTO || mType === MARKET_TYPE.FOREX || mType === MARKET_TYPE.COMMODITIES || mType === MARKET_TYPE.STOCKS;
}

export function isSportsType(mType: number): boolean {
  return mType === MARKET_TYPE.FOOTBALL || mType === MARKET_TYPE.BASKETBALL;
}
