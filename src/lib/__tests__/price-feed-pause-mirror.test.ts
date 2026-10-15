// The app's price-feed symbols split exactly in two: those the resolver can settle on a pinned Chainlink Data Streams
// v8 feed (cf-worker/src/rwa-feeds.json) and those paused for creation (market-availability.ts). A symbol on neither
// side could be created and never settle; one on both would be hidden although it settles (2026-10-15).
import { describe, expect, it } from 'vitest';

import rwaFeeds from '../../../cf-worker/src/rwa-feeds.json';
import { PAUSED_CREATE_MTYPES, PAUSED_PRICE_FEED_SYMBOLS } from '../market-availability';
import { PRICE_FEED_ASSETS } from '../price-feed-assets';

describe('price-feed pause mirrors the resolver feed table', () => {
  it('every app symbol is either settleable (pinned v8 feed of the same class) or paused, never both, never neither', () => {
    const feeds = new Map((rwaFeeds.feeds as { symbol: string; class: string }[]).map((f) => [f.symbol, f.class]));
    for (const a of PRICE_FEED_ASSETS) {
      const settles = feeds.get(a.symbol) === a.class;
      expect({ symbol: a.symbol, settles, paused: PAUSED_PRICE_FEED_SYMBOLS.has(a.symbol) }).toEqual({ symbol: a.symbol, settles, paused: !settles });
    }
    for (const s of PAUSED_PRICE_FEED_SYMBOLS) expect(PRICE_FEED_ASSETS.some((a) => a.symbol === s), s).toBe(true);
    for (const s of feeds.keys()) expect(PRICE_FEED_ASSETS.some((a) => a.symbol === s), s).toBe(true);
  });
  it('no market type is paused as a whole any more', () => {
    expect(PAUSED_CREATE_MTYPES.size).toBe(0);
  });
});
