// The crypto settlement rule (plan r17 §3 steps 1, 4, 5, 7), spec-first: each case below is written from the plan's
// text, then run against src/price-decision.ts. The report is the REAL BTC/USD report observed 1789529160
// (test/fixtures), decoded from its own verified payload; variations change one field at a time.
import { decodeAbiParameters, stringToHex, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import fixture from './fixtures/fixture-btcusd-1789529160.json';
import { decodeVerified, type V3Report } from '../src/datastreams';
import { CRYPTO_FEEDS, decideCrypto, feedFor, MARKET_TYPE_CRYPTO, OUTCOME_NO, OUTCOME_YES, parseCryptoRef } from '../src/price-decision';

const payload = decodeAbiParameters(
  [{ type: 'bytes32[3]' }, { type: 'bytes' }, { type: 'bytes32[]' }, { type: 'bytes32[]' }, { type: 'bytes32' }],
  fixture.fullReport as Hex,
)[1].toLowerCase() as Hex;
const REAL = decodeVerified(payload, 3) as V3Report;
const C = fixture.observationsTimestamp;
const T = C + 60; // a block a minute after close
const BTC = CRYPTO_FEEDS.get('BTC')!;
const ref = (s: string) => stringToHex(s, { size: 32 });
const at18 = (s: string) => parseCryptoRef(ref(`BTC:gt:${s}`))!.strike;

describe('the feed table', () => {
  it('pins exactly the 10 crypto feeds, all v3', () => {
    expect([...CRYPTO_FEEDS.keys()]).toEqual(['BTC', 'ETH', 'SOL', 'AVAX', 'NEAR', 'APT', 'SUI', 'DOGE', 'LINK', 'MON']);
    expect(BTC.feedId).toBe(fixture.feedID);
  });
  it('a symbol with no pinned feed is symbol_paused; an unreadable ref is parse_fail', () => {
    expect(feedFor(MARKET_TYPE_CRYPTO, parseCryptoRef(ref('XRP:gt:1')))).toEqual({ ok: false, reason: 'symbol_paused' });
    expect(feedFor(MARKET_TYPE_CRYPTO, parseCryptoRef(ref('nonsense')))).toEqual({ ok: false, reason: 'parse_fail' });
    expect(feedFor(MARKET_TYPE_CRYPTO, parseCryptoRef(ref('BTC:gt:1')))).toMatchObject({ ok: true, feed: { symbol: 'BTC' } });
  });
  it.each([0, 2, 3, 4, 5, 6, 7])('a market of type %i is never eligible, even with a crypto ref (V4 does not check the ref against the type)', (mType) => {
    expect(feedFor(mType, parseCryptoRef(ref('BTC:gt:60000')))).toEqual({ ok: false, reason: 'class_paused' });
  });
});

describe('the strike, parsed exactly at 10^18', () => {
  it.each([
    ['SUI:gt:1.2', 'SUI', 'gt', 1_200_000_000_000_000_000n],
    ['BTC:lt:75938.79178788', 'BTC', 'lt', 75_938_791_787_880_000_000_000n],
    ['ETH:gt:2000', 'ETH', 'gt', 2_000_000_000_000_000_000_000n],
    ['DOGE:gt:0.000000000000000001', 'DOGE', 'gt', 1n],
  ])('%s', (text, symbol, op, strike) => {
    expect(parseCryptoRef(ref(text))).toEqual({ symbol, op, strike });
  });
  it.each([
    'BTC:gt:0.0000000000000000001', // 19 places
    'BTC:gt:0',
    'BTC:eq:1',
    'BTC:gt:-1',
    'BTC:gt:1e3',
    'BTC:gt:1.',
    'btc:gt:1',
    'BTC:gt: 1',
  ])('refuses %s', (text) => {
    expect(parseCryptoRef(ref(text))).toBeNull();
  });
  it('refuses bytes after the padding starts', () => {
    const r = `${ref('BTC:gt:1').slice(0, -2)}41` as Hex;
    expect(parseCryptoRef(r)).toBeNull();
  });
});

describe('the decision on the real report (price $75,938.79178788)', () => {
  const price = REAL.price;
  it('gt: YES iff price > strike; equality is NO', () => {
    expect(decideCrypto({ symbol: 'BTC', op: 'gt', strike: price - 1n }, BTC, REAL, C, T)).toMatchObject({ kind: 'settle', outcome: OUTCOME_YES });
    expect(decideCrypto({ symbol: 'BTC', op: 'gt', strike: price }, BTC, REAL, C, T)).toMatchObject({ kind: 'settle', outcome: OUTCOME_NO });
    expect(decideCrypto({ symbol: 'BTC', op: 'gt', strike: price + 1n }, BTC, REAL, C, T)).toMatchObject({ kind: 'settle', outcome: OUTCOME_NO });
  });
  it('lt: YES iff price < strike; equality is NO', () => {
    expect(decideCrypto({ symbol: 'BTC', op: 'lt', strike: price + 1n }, BTC, REAL, C, T)).toMatchObject({ kind: 'settle', outcome: OUTCOME_YES });
    expect(decideCrypto({ symbol: 'BTC', op: 'lt', strike: price }, BTC, REAL, C, T)).toMatchObject({ kind: 'settle', outcome: OUTCOME_NO });
    expect(decideCrypto({ symbol: 'BTC', op: 'lt', strike: price - 1n }, BTC, REAL, C, T)).toMatchObject({ kind: 'settle', outcome: OUTCOME_NO });
  });
  it('a human strike written in dollars compares at full precision', () => {
    expect(decideCrypto({ symbol: 'BTC', op: 'gt', strike: at18('75938.79178787') }, BTC, REAL, C, T)).toMatchObject({ outcome: OUTCOME_YES });
    expect(decideCrypto({ symbol: 'BTC', op: 'gt', strike: at18('75938.79178788') }, BTC, REAL, C, T)).toMatchObject({ outcome: OUTCOME_NO });
  });
  it('the window that starts 3 s early but is observed at C is accepted (SPEC §5.2 step 5)', () => {
    expect(REAL.validFromTimestamp).toBe(C - 3);
    expect(decideCrypto({ symbol: 'BTC', op: 'gt', strike: 1n }, BTC, REAL, C, T).kind).toBe('settle');
  });
});

describe('a verified report for another feed or second waits (retryable: the API is untrusted for availability)', () => {
  const base = { symbol: 'BTC', op: 'gt' as const, strike: 1n };
  it.each([
    ['another feed', { feedId: CRYPTO_FEEDS.get('ETH')!.feedId }],
    ['observed one second late', { observationsTimestamp: C + 1 }],
    ['observed one second early', { observationsTimestamp: C - 1 }],
  ])('%s is report_mismatch', (_n, change) => {
    expect(decideCrypto(base, BTC, { ...REAL, ...change }, C, T)).toEqual({ kind: 'wait', reason: 'report_mismatch' });
  });
});

describe('an intrinsic defect of this pool’s report', () => {
  const base = { symbol: 'BTC', op: 'gt' as const, strike: 1n };
  it.each([
    ['valid from after the observation', { validFromTimestamp: C + 1 }],
    ['a zero price', { price: 0n }],
    ['a negative price', { price: -1n }],
  ])('%s is a final refusal (wrong_report)', (_n, change) => {
    expect(decideCrypto(base, BTC, { ...REAL, ...change }, C, T)).toEqual({ kind: 'final', reason: 'wrong_report' });
  });
});

describe('a report that waits', () => {
  const base = { symbol: 'BTC', op: 'gt' as const, strike: 1n };
  it('expired at the block time: the report expires at expiresAt, so expiresAt itself is too late', () => {
    expect(decideCrypto(base, BTC, REAL, C, REAL.expiresAt - 1).kind).toBe('settle');
    expect(decideCrypto(base, BTC, REAL, C, REAL.expiresAt)).toEqual({ kind: 'wait', reason: 'report_expired' });
  });
  it('bid above price, or price above ask: bad_spread', () => {
    expect(decideCrypto(base, BTC, { ...REAL, bid: REAL.price + 1n }, C, T)).toEqual({ kind: 'wait', reason: 'bad_spread' });
    expect(decideCrypto(base, BTC, { ...REAL, ask: REAL.price - 1n }, C, T)).toEqual({ kind: 'wait', reason: 'bad_spread' });
  });
  it('spread exactly 50 bps settles; one wei wider waits', () => {
    const p = 1_000_000n * 10n ** 18n;
    const half = (p * 50n) / 10_000n / 2n;
    const at = { ...REAL, price: p, bid: p - half, ask: p + half };
    expect(decideCrypto(base, BTC, at, C, T).kind).toBe('settle');
    expect(decideCrypto(base, BTC, { ...at, ask: at.ask + 1n }, C, T)).toEqual({ kind: 'wait', reason: 'bad_spread' });
  });
  it('the real report’s spread (1.17 bps) passes', () => {
    expect((REAL.ask - REAL.bid) * 10_000n <= REAL.price * 50n).toBe(true);
  });
});
