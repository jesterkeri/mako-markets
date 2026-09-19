import { describe, expect, it } from 'vitest';
import { CRYPTO_SYMBOLS, PAUSED_SYMBOLS, PRICE_FEED_CLASS } from '../src/assets';
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
  it('every paused symbol is a real price-feed symbol', () => {
    for (const s of PAUSED_SYMBOLS) expect(PRICE_FEED_CLASS.has(s)).toBe(true);
    expect(PAUSED_SYMBOLS.size).toBe(9);
  });
});
