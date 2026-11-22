// ----------------------------------------------------------------------------
// price-recorder/src/feeds.ts
//
// The feeds the recorder follows are exactly the resolver's feed tables, read from its own files (plan 3.1): the 10
// crypto feeds (schema v3) and the forex, metals and stocks feeds (schema v8). Nothing is copied.
// ----------------------------------------------------------------------------

import cryptoFeeds from '../../cf-worker/src/crypto-feeds.json';
import rwaFeeds from '../../cf-worker/src/rwa-feeds.json';

export type FeedClass = 'crypto' | 'forex' | 'commodities' | 'stocks';
export type Feed = { symbol: string; feedId: `0x${string}`; schema: 3 | 8; class: FeedClass };

const lower = (id: string) => id.toLowerCase() as `0x${string}`;

export const FEEDS: readonly Feed[] = [
  ...(cryptoFeeds.feeds as { symbol: string; feedId: string; schema: number }[]).map((f) => ({ symbol: f.symbol, feedId: lower(f.feedId), schema: f.schema as 3 | 8, class: 'crypto' as const })),
  ...(rwaFeeds.feeds as { symbol: string; class: string; feedId: string; schema: number }[]).map((f) => ({ symbol: f.symbol, feedId: lower(f.feedId), schema: f.schema as 3 | 8, class: f.class as FeedClass })),
];

export const FEED_BY_SYMBOL: ReadonlyMap<string, Feed> = new Map(FEEDS.map((f) => [f.symbol, f]));
