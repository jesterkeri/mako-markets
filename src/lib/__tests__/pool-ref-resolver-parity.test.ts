// The pool page may say a price pool settles automatically (and take bets) only if the LIVE resolver can settle it
// (Codex DS_RWA R1). The contract stores whatever bytes32 a direct createMarket passes, so this runs the page's parser
// (src/lib/pool-rules.ts parseOracleRef / unsettleable) and the resolver's live Data Streams parsers on the same refs:
// crypto cf-worker/src/price-decision.ts feedFor(parseCryptoRef), forex/metals/stocks cf-worker/src/rwa-decision.ts
// rwaFeedFor(parseRwaRef). Settles on the page <=> eligible in the resolver, both ways. A feed the resolver pins but
// Chainlink refuses (401 "feeds not authorized", UNAUTHORIZED_FEED_SYMBOLS, 2026-10-16) is not eligible: the resolver's
// fetch for it can only wait.
import { stringToHex, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { feedFor, parseCryptoRef } from '../../../cf-worker/src/price-decision';
import { parseRwaRef, rwaFeedFor } from '../../../cf-worker/src/rwa-decision';
import { MarketType } from '../contract';
import { PAUSED_PRICE_FEED_SYMBOLS, UNAUTHORIZED_FEED_SYMBOLS } from '../market-availability';
import { PRICE_FEED_ASSETS } from '../price-feed-assets';
import { unsettleable } from '../pool-rules';

const ref = (s: string) => stringToHex(s, { size: 32 });
const resolverEligible = (mType: number, r: Hex) => {
  if (mType === MarketType.CRYPTO) return feedFor(mType, parseCryptoRef(r)).ok;
  const f = rwaFeedFor(mType, parseRwaRef(r));
  return f.ok && !UNAUTHORIZED_FEED_SYMBOLS.has(f.feed.symbol);
};
const pageSettles = (mType: number, r: Hex) => !unsettleable({ mType, oracleRef: r });

const STRIKES = ['1', '1.1', '0.5', '.5', '+5', '+1.25', '1e3', '0', '0.0', '00.10', '1.123456789012345678', '1.1234567890123456789', '1,000', '-1', ' 1', '1 '];
const WRAPS: ((s: string) => string)[] = [(s) => s, (s) => `${s}\t`, (s) => ` ${s}`, (s) => `${s}\n`, (s) => s.replace(':', ' :'), (s) => `${s} `];

function vectors(): { mType: number; text: string }[] {
  const out: { mType: number; text: string }[] = [];
  const cryptoSyms = ['BTC', 'ETH', 'SUI', 'XRP', 'btc'];
  for (const sym of cryptoSyms) for (const op of ['gt', 'lt', 'eq']) for (const k of STRIKES) for (const w of WRAPS) out.push({ mType: MarketType.CRYPTO, text: w(`${sym}:${op}:${k}`) });
  const classOf = { forex: MarketType.FOREX, commodities: MarketType.COMMODITIES, stocks: MarketType.STOCKS } as const;
  for (const a of PRICE_FEED_ASSETS) {
    for (const mType of [MarketType.FOREX, MarketType.COMMODITIES, MarketType.STOCKS]) {
      for (const k of ['1.1', '.5', '+2', '1.123456789012345678', '1.1234567890123456789', '1e3', '0']) {
        const text = `${a.symbol}:gt:${k}`;
        if (text.length <= 32) out.push({ mType, text });
      }
    }
    out.push({ mType: classOf[a.class], text: `${a.symbol}:lt:1.5\t` });
    out.push({ mType: classOf[a.class], text: `${a.symbol.toLowerCase()}:lt:1.5` });
  }
  return out.filter((v) => new TextEncoder().encode(v.text).length <= 32);
}

describe('pool page <=> live resolver, on the same refs', () => {
  const vs = vectors();
  it(`agrees on all ${vs.length} refs (settles on the page iff the resolver can settle it)`, () => {
    const disagree = vs.filter((v) => pageSettles(v.mType, ref(v.text)) !== resolverEligible(v.mType, ref(v.text))).map((v) => ({ ...v, page: pageSettles(v.mType, ref(v.text)) }));
    expect(disagree).toEqual([]);
    expect(vs.length).toBeGreaterThan(1000);
  });
  it('BAC and MA: pinned in the resolver, refused by Chainlink, so unsettleable on the page (no new bets)', () => {
    for (const s of ['BAC', 'MA']) {
      expect(rwaFeedFor(MarketType.STOCKS, parseRwaRef(ref(`${s}:gt:100`))).ok, s).toBe(true);
      expect(unsettleable({ mType: MarketType.STOCKS, oracleRef: ref(`${s}:gt:100`) }), s).toBe(true);
    }
    expect(unsettleable({ mType: MarketType.STOCKS, oracleRef: ref('JPM:gt:100') })).toBe(false);
  });
  it('Codex DS_RWA R1 scenarios: a paused symbol and a 19-decimal strike are unsettleable on the page (no bets)', () => {
    for (const s of PAUSED_PRICE_FEED_SYMBOLS) {
      const mType = { forex: MarketType.FOREX, commodities: MarketType.COMMODITIES, stocks: MarketType.STOCKS }[PRICE_FEED_ASSETS.find((a) => a.symbol === s)!.class];
      expect(unsettleable({ mType, oracleRef: ref(`${s}:gt:1`) }), s).toBe(true);
    }
    expect(unsettleable({ mType: MarketType.FOREX, oracleRef: ref('EURUSD:gt:1.1234567890123456789') })).toBe(true);
    expect(unsettleable({ mType: MarketType.FOREX, oracleRef: ref('EURUSD:gt:1.123456789012345678') })).toBe(false);
  });
  it('crypto as the live resolver reads it: plain strikes only, no whitespace, no + or exponent', () => {
    expect(unsettleable({ mType: MarketType.CRYPTO, oracleRef: ref('BTC:gt:75000.5') })).toBe(false);
    for (const t of ['BTC:gt:1e3', 'BTC:gt:+5', 'BTC:gt:.5', 'BTC:gt:1 ', ' BTC:gt:1', 'BTC :gt:1', 'BTC:gt:0']) {
      expect(unsettleable({ mType: MarketType.CRYPTO, oracleRef: ref(t) }), t).toBe(true);
    }
  });
});
