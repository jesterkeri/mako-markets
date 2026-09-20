// MIRROR_ORACLE_REF_PARSERS, MIRROR_CRYPTO_CUTOFF.
//
// Slice-1 review r8: a marker proves a copy was declared, not that it still
// behaves like its original. `scripts/check-mirrors.mjs` can pass while
// `cf-worker/src/index.ts` starts accepting a reference the watchdog still
// calls unsupported, which would raise a UO alert for a market the resolver
// settles happily, or hide one it cannot.
//
// So run one shared vector table through BOTH implementations and require the
// same verdict. The resolver's parsers are imported from the deployed Worker
// source itself, not from a copy of it.
import { describe, expect, it } from 'vitest';
import { stringToHex } from 'viem';
import {
  parseBasketballOracleRef as resolverBasketball,
  parseCryptoOracleRef as resolverCrypto,
  parseFootballOracleRef as resolverFootball,
  parsePriceFeedOracleRef as resolverPriceFeed,
} from '../../cf-worker/src/index';
import { suggestedCryptoBettingCloseTimeMirror } from '../../src/lib/market-timing';
import { PRICE_FEED_CLASSES, PRICE_FEED_VECTORS } from '../../test-vectors/price-feed-oracle-ref';
import { parseBasketballOracleRef, parseCryptoOracleRef, parseFootballOracleRef, parsePriceFeedOracleRef } from '../src/oracle-ref';
import { suggestedCryptoCutoff } from '../src/classify';

const hex = (s: string) => stringToHex(s, { size: 32 });

/// Valid forms, every rejection mode both parsers are supposed to share, and
/// the quirks the copies were told to keep (the crypto strike goes through
/// Number() with no pattern; the price-feed strike through a pattern first).
const CRYPTO = [
  'BTC:gt:100000', 'ETH:lt:2000', 'SOL:gt:0.5', 'MON:gt:1',
  'BTC:gt:1e5', 'BTC:gt:0x10', 'BTC:gt: 100 ', 'BTC:GT:1', 'btc:gt:1',
  'PEPE:gt:1', 'BTC:gt:0', 'BTC:gt:-1', 'BTC:gt:abc', 'BTC:gt:', 'BTC:gt',
  'BTC:gt:1:2', '', ':::', 'BTC::1', 'BTC:ge:1', 'BTC:gt:Infinity', 'BTC:gt:.5',
  'BTC:gt:+1', 'BTC:gt:1.', 'BTC:gt:1_000',
];
const FOOTBALL = [
  '12345:home_win:0', '7:btts:0', '99:over:2.5', '1:draw:0', '1:under:0.5',
  'abc:home_win:0', '12a:over:1', '1:win:0', '1:over:-1', '1:over:abc',
  '1:over', '1:over:1:2', '', '01:draw:0', ' 7 : draw : 0 ',
];
const BASKETBALL = [
  '555:home_win:0', '555:over:210.5', '555:draw:0', '555:under:0',
  'x:over:1', '555:over:-1', '555:over', '', '555:away_win:0',
];
/// The price-feed vectors come from test-vectors/, because a THIRD copy of
/// this parser (the sponsor-time gate in src/lib/aa-call-allowlist.ts) is
/// checked against the same table from the app's own suite. That gate is a
/// `server-only` module and cannot be imported here.
const PRICE_FEED: [string, 'forex' | 'commodities' | 'stocks'][] = PRICE_FEED_VECTORS.flatMap((v) =>
  PRICE_FEED_CLASSES.map((cls) => [v.ref, cls] as [string, 'forex' | 'commodities' | 'stocks']),
);

describe('the watchdog parsers agree with the resolver they mirror', () => {
  it('crypto', () => {
    for (const ref of CRYPTO) {
      const mine = parseCryptoOracleRef(hex(ref));
      const theirs = resolverCrypto(hex(ref));
      expect(!!mine, ref).toBe(!!theirs);
      if (mine && theirs) expect([mine.symbol, mine.op, mine.strike], ref).toEqual([theirs.symbol, theirs.op, theirs.strike]);
    }
  });

  it('football', () => {
    for (const ref of FOOTBALL) {
      const theirs = resolverFootball(hex(ref));
      const mine = parseFootballOracleRef(hex(ref));
      expect(!!mine, ref).toBe(!!theirs);
      if (mine && theirs) expect(mine.matchId, ref).toBe(theirs.matchId);
    }
  });

  it('basketball', () => {
    for (const ref of BASKETBALL) {
      const theirs = resolverBasketball(hex(ref));
      const mine = parseBasketballOracleRef(hex(ref));
      expect(!!mine, ref).toBe(!!theirs);
      if (mine && theirs) expect(mine.gameId, ref).toBe(theirs.gameId);
    }
  });

  it('forex, commodities and stocks, including the class check', () => {
    for (const [ref, cls] of PRICE_FEED) {
      const label = `${ref} as ${cls}`;
      const theirs = resolverPriceFeed(hex(ref), cls);
      const mine = parsePriceFeedOracleRef(hex(ref), cls);
      expect(!!mine, label).toBe(!!theirs);
      if (mine && theirs) expect([mine.symbol, mine.op, mine.strike], label).toEqual([theirs.symbol, theirs.op, theirs.strike]);
    }
  });

  it('the resolver still matches the shared vector table the app copy is pinned to', () => {
    // Without this, the table could drift away from the resolver and the
    // sponsor-gate test would be checking against nothing.
    for (const v of PRICE_FEED_VECTORS) {
      for (const cls of PRICE_FEED_CLASSES) {
        const got = resolverPriceFeed(hex(v.ref), cls);
        const want = v.accepts[cls] ?? null;
        const label = `${v.ref} as ${cls}`;
        expect(!!got, label).toBe(!!want);
        if (got && want) expect([got.symbol, got.op, got.strike], label).toEqual([want.symbol, want.op, want.strike]);
      }
    }
  });

  it('the vector table actually exercises both verdicts', () => {
    const all = CRYPTO.map((r) => !!resolverCrypto(hex(r)));
    expect(all.filter(Boolean).length).toBeGreaterThan(2);
    expect(all.filter((x) => !x).length).toBeGreaterThan(10);
  });
});

describe('the watchdog crypto cutoff agrees with the app copy', () => {
  it('across every tier boundary', () => {
    const created = 1_800_000_000;
    const HOUR = 3600;
    const durations = [
      -1, 0, 1, 60, HOUR - 1, HOUR, HOUR + 1,
      24 * HOUR - 1, 24 * HOUR, 24 * HOUR + 1,
      72 * HOUR - 1, 72 * HOUR, 72 * HOUR + 1,
      7 * 24 * HOUR, 7 * 24 * HOUR + 1, 999, 12_345,
    ];
    for (const d of durations) {
      const mine = suggestedCryptoCutoff(created, created + d);
      const theirs = suggestedCryptoBettingCloseTimeMirror(created, created + d);
      expect(BigInt(mine), `duration ${d}`).toBe(theirs);
    }
  });
});
