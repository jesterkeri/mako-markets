import { describe, expect, it } from 'vitest';
import { CRYPTO_SYMBOLS, FEED_STATUS, PAUSED_SYMBOLS, PRICE_FEED_CLASS } from '../src/assets';
// The resolver's allowlist and the app's crypto list: the watchdog's copies
// must match them exactly, or UO would disagree with what the resolver does.
import { PRICE_FEED_ASSETS } from '../../cf-worker/src/price-feed-assets';
import { CRYPTO_SYMBOLS as APP_CRYPTO } from '../../src/lib/crypto-assets';

describe('allowlist drift', () => {
  it('price-feed symbols and classes match cf-worker/src/price-feed-assets.ts', () => {
    const theirs = new Map(PRICE_FEED_ASSETS.map((a) => [a.symbol, a.class]));
    expect(new Map(PRICE_FEED_CLASS)).toEqual(theirs);
  });
  it('crypto symbols match src/lib/crypto-assets.ts (the resolver mirrors the same list)', () => {
    expect([...CRYPTO_SYMBOLS].sort()).toEqual([...APP_CRYPTO].sort());
  });
  it('the feed-status table covers exactly the symbols the resolver knows', () => {
    const known = [...CRYPTO_SYMBOLS, ...PRICE_FEED_CLASS.keys()].sort();
    expect(Object.keys(FEED_STATUS).sort()).toEqual(known);
  });
  it('the paused set is exactly the table entries with status paused (feed map of 2026-09-18)', () => {
    // Pinned so a regenerated table that changes the set shows up in review.
    expect([...PAUSED_SYMBOLS].sort()).toEqual(['AMD', 'BA', 'DIS', 'EURGBP', 'EURJPY', 'GBPJPY', 'GS', 'KO', 'PEP']);
    for (const [sym, status] of Object.entries(FEED_STATUS)) expect(PAUSED_SYMBOLS.has(sym)).toBe(status === 'paused');
  });
});
