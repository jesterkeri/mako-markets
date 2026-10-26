// Pool naming engine (naming plan r8 §4, §5, §8): price titles state the rule the resolver settles on, at a fixed UTC
// second; old pools keep their stored wording unless they settle on that exact second; nothing a creator types
// reaches a price pool's title or line unless it is one of the reviewed record's vetted wordings.

import { describe, expect, it } from 'vitest';

import { MarketType, type MarketWithId } from '../contract';
import { CRYPTO_SYMBOLS } from '../crypto-assets';
import { decodeMarket } from '../hooks';
import { MAKO_RELEASES } from '../mako-release-record';
import { MAX_DURATION_SEC, SHEET_HOLD_SEC, suggestedCryptoBettingCloseTimeMirror } from '../market-timing';
import { PAUSED_PRICE_FEED_SYMBOLS } from '../market-availability';
import { toBytes32 } from '../oracle';
import { buildPool, DURATIONS, groupStrike, utcMoment, type PriceKind } from '../pool-create';
import { firstWorded, oldWording, poolTitle } from '../pool-display';
import { PRICE_FEED_ASSETS } from '../price-feed-assets';
import fixture from './fixtures/v4-price-pools-0-151.json';

const V4 = MAKO_RELEASES[0];
const NOW = 1_800_000_000; // a whole minute
const ok = (r: ReturnType<typeof buildPool>) => {
  if (!r.ok) throw new Error(r.reason);
  return r.pool;
};
const bytes = (s: string) => new TextEncoder().encode(s).length;
/// A pool as decodeMarket / readPoolForShare see it.
const pool = (p: { id: number | bigint; mType: number; ref?: string; oracleRef?: `0x${string}`; question: string; closeTime: number | bigint }) => ({
  id: BigInt(p.id),
  mType: p.mType as MarketType,
  oracleRef: p.oracleRef ?? toBytes32(p.ref!),
  question: p.question,
  closeTime: BigInt(p.closeTime),
});

const SYMBOLS: [PriceKind, string][] = [
  ...CRYPTO_SYMBOLS.map((s): [PriceKind, string] => ['crypto', s]),
  ...PRICE_FEED_ASSETS.map((a): [PriceKind, string] => [a.class, a.symbol]),
];
const STRIKES = [0.000001, 0.0275, 1.0845, 151.234, 84546, 1e20];

describe('new price titles', () => {
  it('fit on chain for every symbol, duration, direction and strike, and say exactly the strike that settles', () => {
    let max = 0;
    for (const [kind, symbol] of SYMBOLS)
      for (const d of DURATIONS)
        for (const direction of ['above', 'below'] as const)
          for (const strike of STRIKES) {
            const r = buildPool({ kind, symbol, direction, strike, durationSec: d.seconds }, NOW);
            if (!r.ok) {
              // Refused only when the settlement reference itself is longer than 32 bytes.
              expect(r.reason).toBe('This choice does not fit in a pool reference. Pick another.');
              expect(bytes(`${symbol}:${direction === 'above' ? 'gt' : 'lt'}:${String(strike)}`)).toBeGreaterThan(32);
              continue;
            }
            const q = r.pool.question;
            max = Math.max(max, bytes(q));
            expect(bytes(q)).toBeLessThanOrEqual(200);
            const shown = / be (?:above|below) \$?([\d,.]+) at /.exec(q)?.[1];
            expect(shown?.replace(/,/g, '')).toBe(r.pool.oracleRef.split(':')[2]);
          }
    expect(max).toBeLessThanOrEqual(90);
  });

  it('round trip: a pool read back from chain shows exactly the title it was created with, and no line', () => {
    for (const [kind, symbol] of SYMBOLS)
      for (const d of DURATIONS)
        for (const strike of [0.0275, 151.234, 84546]) {
          const r = buildPool({ kind, symbol, direction: 'below', strike, durationSec: d.seconds }, NOW);
          if (!r.ok) continue;
          const t = poolTitle(pool({ id: 152, mType: r.pool.mType, ref: r.pool.oracleRef, question: r.pool.question, closeTime: r.pool.closeTime }), V4);
          // A paused feed is never settled (pool-rules.ts parseOracleRef), so its pools show no rule at all.
          expect(t).toEqual(PAUSED_PRICE_FEED_SYMBOLS.has(symbol) ? { title: 'Pool #152' } : { title: r.pool.question });
          expect(oldWording(pool({ id: 152, mType: r.pool.mType, ref: r.pool.oracleRef, question: r.pool.question, closeTime: r.pool.closeTime }))).toBeNull();
        }
  });

  it('one title per kind and direction, plus USD/JPY with the exact digits typed', () => {
    const t = (kind: PriceKind, symbol: string, direction: 'above' | 'below', strike: number, durationSec = 3600) =>
      ok(buildPool({ kind, symbol, direction, strike, durationSec }, NOW)).question;
    // NOW = 2027-01-15T08:00:00Z; 1H closes at NOW + 3720 = 09:02.
    expect(t('crypto', 'BTC', 'above', 84546)).toBe('Will BTC be above $84,546 at 09:02 UTC on Fri 15 Jan?');
    expect(t('crypto', 'MON', 'below', 0.0275)).toBe('Will MON be below $0.0275 at 09:02 UTC on Fri 15 Jan?');
    expect(t('stocks', 'NVDA', 'above', 200)).toBe('Will NVDA be above $200 at 09:02 UTC on Fri 15 Jan?');
    expect(t('stocks', 'AAPL', 'below', 1234.5)).toBe('Will AAPL be below $1,234.5 at 09:02 UTC on Fri 15 Jan?');
    expect(t('forex', 'EURUSD', 'above', 1.095)).toBe('Will EUR/USD be above 1.095 at 09:02 UTC on Fri 15 Jan?');
    expect(t('forex', 'EURUSD', 'below', 1.0845)).toBe('Will EUR/USD be below 1.0845 at 09:02 UTC on Fri 15 Jan?');
    expect(t('forex', 'USDJPY', 'above', 151.234)).toBe('Will USD/JPY be above 151.234 at 09:02 UTC on Fri 15 Jan?');
    expect(t('commodities', 'XAUUSD', 'above', 4100)).toBe('Will XAU/USD be above 4,100 at 09:02 UTC on Fri 15 Jan?');
    expect(t('commodities', 'XAUUSD', 'below', 4100)).toBe('Will XAU/USD be below 4,100 at 09:02 UTC on Fri 15 Jan?');
  });

  it('copy rules: printable ASCII titles, no dashes, no we/our/us, the brand singular', () => {
    const texts: string[] = [];
    for (const [kind, symbol] of SYMBOLS) {
      const r = buildPool({ kind, symbol, direction: 'above', strike: 1.5, durationSec: 300 }, NOW);
      if (r.ok) texts.push(r.pool.question);
    }
    for (const q of texts) expect(q).toMatch(/^[\x20-\x7e]+$/);
    const line = firstWorded('Will BTC close above $83,368 in 7 days?');
    expect(line).toBe('First worded as “Will BTC close above $83,368 in 7 days?”. That wording may not match the rule. The title above is built from the price check this pool settles on.');
    const reasons = [
      line,
      (buildPool({ kind: 'crypto', symbol: 'DOGE', direction: 'above', strike: 0.0000012345678901234567, durationSec: 300 }, NOW) as { reason: string }).reason,
    ];
    for (const s of [...texts, ...reasons]) {
      expect(s).not.toMatch(/[–—]/);
      expect(s).not.toMatch(/\b(we|our|us)\b/i);
      expect(s).not.toMatch(/Mako Markets/);
    }
  });
});

describe('utcMoment: fixed strings, never Intl', () => {
  it('every month of 2026 by its three-letter name, every weekday, seconds only when not :00', () => {
    // Expected values computed independently (Python datetime, UTC).
    const cases: [number, string][] = [
      [1767416820, '05:07 UTC on Sat 3 Jan'],
      [1770200040, '10:14 UTC on Wed 4 Feb'],
      [1772724060, '15:21 UTC on Thu 5 Mar'],
      [1775507280, '20:28 UTC on Mon 6 Apr'],
      [1778117700, '01:35 UTC on Thu 7 May'],
      [1780900920, '06:42 UTC on Mon 8 Jun'],
      [1783597740, '11:49 UTC on Thu 9 Jul'],
      [1786380960, '16:56 UTC on Mon 10 Aug'],
      [1789160580, '21:03 UTC on Fri 11 Sep'],
      [1791771000, '02:10 UTC on Mon 12 Oct'],
      [1794554220, '07:17 UTC on Fri 13 Nov'],
      [1797251040, '12:24 UTC on Mon 14 Dec'],
      [1772323200, '00:00 UTC on Sun 1 Mar'],
      [1793181840, '10:04 UTC on Wed 28 Oct'],
      [1793132043, '20:14:03 UTC on Tue 27 Oct'],
    ];
    for (const [sec, s] of cases) expect(utcMoment(sec)).toBe(s);
    const days = new Set(cases.map(([, s]) => s.split(' ')[3]));
    expect([...days].sort()).toEqual(['Fri', 'Mon', 'Sat', 'Sun', 'Thu', 'Tue', 'Wed']);
    expect(utcMoment(1789160580)).not.toContain('Sept');
  });
});

describe('groupStrike', () => {
  it('keeps every digit, groups the integer part, shows .5 as 0.5, drops leading zeros, refuses what cannot settle', () => {
    expect(groupStrike('84546')).toBe('84,546');
    expect(groupStrike('1234567.891')).toBe('1,234,567.891');
    expect(groupStrike('100000000000000000000')).toBe('100,000,000,000,000,000,000');
    expect(groupStrike('0.0275')).toBe('0.0275');
    expect(groupStrike('.5')).toBe('0.5');
    expect(groupStrike('0084')).toBe('84');
    expect(groupStrike('1e-7')).toBeNull();
    expect(groupStrike('1e+21')).toBeNull();
    expect(groupStrike('0.' + '1'.repeat(18))).toBe('0.' + '1'.repeat(18));
    expect(groupStrike('0.' + '1'.repeat(19))).toBeNull();
  });
});

describe('close times (whole minute, 30 s hold, 7D rounded down)', () => {
  const tiered = new Set([3600, 86400, 259200]);
  it('for every duration and every second of the minute', () => {
    for (const d of DURATIONS)
      for (let s = 0; s < 60; s++) {
        const now = NOW + s;
        const p = ok(buildPool({ kind: 'crypto', symbol: 'BTC', direction: 'above', strike: 1, durationSec: d.seconds }, now));
        const close = Number(p.closeTime);
        expect(close % 60).toBe(0);
        if (d.seconds === MAX_DURATION_SEC) {
          // Never later than today's now + MAX - 60, so a fast device clock keeps at least 60 s of tolerance.
          expect(close - now).toBeGreaterThanOrEqual(MAX_DURATION_SEC - 119);
          expect(close - now).toBeLessThanOrEqual(MAX_DURATION_SEC - 60);
          continue;
        }
        expect(close - now).toBeGreaterThanOrEqual(d.seconds + 90);
        expect(close - now).toBeLessThanOrEqual(d.seconds + 149);
        // Today's margins still hold after a full hold.
        expect(close - (now + SHEET_HOLD_SEC)).toBeGreaterThanOrEqual(d.seconds + 60);
        expect(p.bettingCloseTime).toBe(suggestedCryptoBettingCloseTimeMirror(now, close));
        if (tiered.has(d.seconds)) {
          // The tier holds while the create's block time is less than 59 s after the end of the hold.
          expect(close - d.seconds - 1).toBeGreaterThanOrEqual(now + SHEET_HOLD_SEC + 59);
          expect(p.bettingCloseTime <= suggestedCryptoBettingCloseTimeMirror(close - d.seconds - 1, close)).toBe(true);
          expect(p.bettingCloseTime > suggestedCryptoBettingCloseTimeMirror(close - d.seconds, close)).toBe(true);
        }
      }
  });
});

describe('decimals', () => {
  it('refuses more than 18 decimal places and builds exactly 18', () => {
    expect(buildPool({ kind: 'crypto', symbol: 'DOGE', direction: 'above', strike: 0.0000012345678901234567, durationSec: 300 }, NOW)).toEqual({
      ok: false,
      reason: 'This target has more than 18 decimal places, which a pool cannot settle. Use fewer.',
    });
    const p = ok(buildPool({ kind: 'crypto', symbol: 'DOGE', direction: 'above', strike: 0.123456789012345678, durationSec: 300 }, NOW));
    expect(p.oracleRef).toBe('DOGE:gt:0.12345678901234568');
    const exact18 = ok(buildPool({ kind: 'crypto', symbol: 'DOGE', direction: 'above', strike: 0.000001234567890123, durationSec: 300 }, NOW));
    expect(exact18.oracleRef.split(':')[2]).toMatch(/^0\.\d{18}$/);
  });
});

describe('old pools (fixture: every V4 price pool 0..151 read from chain)', () => {
  const BUILT = [93, 101, 103, 109, 114, 118, 122, 123, 124, 126, 127, 129, 130, 136, 137, 138, 140, 142, 143, 145, 147, 149, 150, 151];
  const pools = fixture.pools as { id: number; mType: number; oracleRef: `0x${string}`; ref: string; question: string; closeTime: number }[];
  const byId = new Map(pools.map((p) => [p.id, p]));
  const title = (id: number) => poolTitle(pool(byId.get(id)!), V4);

  it('the fixture is 120 price pools from the V4 contract on chain 10143', () => {
    expect(pools).toHaveLength(120);
    expect(fixture._source).toMatchObject({ contract: V4.address, chainId: 10143, nextMarketId: 152 });
  });

  it('exactly the 24 post-cutover pools are built and carry the line; the other 96 keep their stored text', () => {
    const built: number[] = [];
    for (const p of pools) {
      const t = poolTitle(pool(p), V4);
      expect(t.title).not.toMatch(/^Pool #/);
      if (t.title === p.question) {
        expect(t.originalWording).toBeUndefined();
      } else {
        built.push(p.id);
        expect(t.originalWording).toBe(p.question);
      }
    }
    expect(built).toEqual(BUILT);
  });

  it('named pools', () => {
    expect(title(151)).toEqual({ title: 'Will BTC be above $83,368 at 20:14:03 UTC on Tue 27 Oct?', originalWording: 'Will BTC close above $83,368 in 7 days?' });
    expect(title(137)).toEqual({ title: 'Will EUR/USD be above 1.1 at 12:32:28 UTC on Thu 22 Oct?', originalWording: 'Will EURUSD trade above 1.1 in 7 days?' });
    expect(title(138)).toEqual({ title: 'Will EUR/USD be above 1.1 at 07:17:42 UTC on Fri 16 Oct?', originalWording: 'Will EURUSD trade above 1.1 in 5 minutes?' });
    expect(title(130).title).toBe('Will BTC be above $80,000 at 08:07:26 UTC on Sun 18 Oct?');
    expect(title(93).title).toBe('Will BTC be above $84,245 at 18:59:10 UTC on Wed 14 Oct?');
    expect(title(110)).toEqual({ title: 'Will SOL close above $111 in 1 hour?' });
    expect(title(88)).toEqual({ title: 'Will NVDA close above 200 in 1 hour?' });
    expect(title(77)).toEqual({ title: 'Will XAUUSD settle below 2400 in 3 days?' });
    expect(title(72)).toEqual({ title: 'Will USDJPY trade above 1.08 in 3 days?' });
    // Paused symbols, refunded, closed before the cutover: their stored text stays.
    expect(title(20)).toEqual({ title: 'Will EURJPY trade above 1.08 in 7 days?' });
    expect(title(32)).toEqual({ title: 'Will AMD close above 500 in 24 hours?' });
  });

  it('the cutover boundary, per class', () => {
    const at = (mType: number, ref: string, question: string, closeTime: number) => poolTitle(pool({ id: 200, mType, ref, question, closeTime }), V4).title;
    const c = V4.dsSince.crypto;
    const r = V4.dsSince.rwa;
    expect(at(MarketType.CRYPTO, 'BTC:gt:90000', 'Will BTC close above $90,000 in 5 minutes?', c - 1)).toBe('Will BTC close above $90,000 in 5 minutes?');
    expect(at(MarketType.CRYPTO, 'BTC:gt:90000', 'Will BTC close above $90,000 in 5 minutes?', c)).toBe(`Will BTC be above $90,000 at ${utcMoment(c)}?`);
    expect(at(MarketType.FOREX, 'EURUSD:gt:1.1', 'Will EURUSD trade above 1.1 in 5 minutes?', r - 1)).toBe('Will EURUSD trade above 1.1 in 5 minutes?');
    expect(at(MarketType.FOREX, 'EURUSD:gt:1.1', 'Will EURUSD trade above 1.1 in 5 minutes?', r)).toBe(`Will EUR/USD be above 1.1 at ${utcMoment(r)}?`);
    // Forex pools between the crypto and the forex cutover still keep their stored text.
    expect(at(MarketType.FOREX, 'EURUSD:gt:1.1', 'Will EURUSD trade above 1.1 in 5 minutes?', c)).toBe('Will EURUSD trade above 1.1 in 5 minutes?');
  });

  it('crafted pools: the built title and no line, or Pool #N; the stored text never shows', () => {
    const p151 = byId.get(151)!;
    const t = (id: number, mType: number, ref: string, question: string, closeTime = p151.closeTime) => poolTitle(pool({ id, mType, ref, question, closeTime }), V4);
    const built = `Will BTC be above $90,000 at ${utcMoment(p151.closeTime)}?`;
    expect(t(152, MarketType.CRYPTO, 'BTC:gt:90000', 'Will BTC close above $50,000 in 7 days?')).toEqual({ title: built });
    expect(t(152, MarketType.CRYPTO, 'BTC:gt:90000', 'Claim your prize at https://mak0.example @admin')).toEqual({ title: built });
    // Unreadable references whose question passes oldWording: never rendered.
    expect(t(152, MarketType.CRYPTO, 'BTC:gt:0.0000000000000000001', 'Will BTC close above $0.0000000000000000001 in 5 minutes?')).toEqual({ title: 'Pool #152' });
    expect(t(152, MarketType.CRYPTO, 'PEPE:gt:1', 'Will PEPE close above $1 in 7 days?')).toEqual({ title: 'Pool #152' });
  });

  it('the line: only one of the 24 vetted texts, on its own id, while it agrees with the reference', () => {
    const p151 = byId.get(151)!;
    const t = (id: number, ref: string, question: string) => poolTitle(pool({ id, mType: MarketType.CRYPTO, ref, question, closeTime: p151.closeTime }), V4);
    // A pool made after the read (id 152) with an old-style question that agrees with its ref.
    expect(t(152, 'BTC:gt:90000', 'Will BTC close above $90,000 in 5 minutes?').originalWording).toBeUndefined();
    // Pool 151's ref, close time and exact question on another id.
    expect(t(152, p151.ref, p151.question).originalWording).toBeUndefined();
    // Pool 151 with one byte changed, still passing oldWording.
    expect(oldWording(pool({ ...p151, question: 'Will BTC close above $83368 in 7 days?' }))).not.toBeNull();
    expect(t(151, p151.ref, 'Will BTC close above $83368 in 7 days?').originalWording).toBeUndefined();
    // Pool 151's id and exact vetted question, but a reference it does not agree with.
    expect(t(151, 'BTC:gt:10', p151.question)).toEqual({ title: `Will BTC be above $10 at ${utcMoment(p151.closeTime)}?` });
    // And the real pool 151 shows it.
    expect(t(151, p151.ref, p151.question).originalWording).toBe(p151.question);
  });

  it('the record vets exactly the 24 built ids, each with its question as read from chain', () => {
    expect(Object.keys(V4.vettedWording).map(Number).sort((a, b) => a - b)).toEqual(BUILT);
    for (const id of BUILT) expect(V4.vettedWording[id]).toBe(byId.get(id)!.question);
  });

  it('sports and house pools keep their stored question', () => {
    const late = V4.dsSince.crypto + 86400;
    expect(poolTitle(pool({ id: 5, mType: MarketType.FOOTBALL, ref: '537890:over:2.5', question: 'Over 2.5 goals in Arsenal vs Chelsea?', closeTime: late }), V4)).toEqual({ title: 'Over 2.5 goals in Arsenal vs Chelsea?' });
    expect(poolTitle(pool({ id: 6, mType: MarketType.BASKETBALL, ref: '18444:over:220', question: 'Over 220 total points in Jazz @ Grizzlies?', closeTime: late }), V4)).toEqual({ title: 'Over 220 total points in Jazz @ Grizzlies?' });
    expect(poolTitle(pool({ id: 7, mType: MarketType.MAKO, ref: 'mako', question: 'Will it rain in Lagos on Sat 17 Oct?', closeTime: late }), V4)).toEqual({ title: 'Will it rain in Lagos on Sat 17 Oct?' });
  });

  it('decodeMarket shows the built title and keeps the stored text in chainQuestion', () => {
    const p = byId.get(151)!;
    const raw = { ...pool(p), creator: '0x0000000000000000000000000000000000000001', createdAt: 0n, bettingCloseTime: 0n, totalYes: 0n, totalNo: 0n, yesBettorCount: 0, noBettorCount: 0, outcome: 0, resolved: false, creatorFeeClaimed: false, protocolFeeBpsSnapshot: 100, creatorFeeBpsSnapshot: 200 };
    const m: MarketWithId = decodeMarket(raw, 151n);
    expect(m).toMatchObject({ question: 'Will BTC be above $83,368 at 20:14:03 UTC on Tue 27 Oct?', originalWording: p.question, chainQuestion: p.question });
    const sport = decodeMarket({ ...raw, mType: MarketType.FOOTBALL, question: 'Will Arsenal beat Chelsea?' }, 5n);
    expect(sport).toMatchObject({ question: 'Will Arsenal beat Chelsea?', chainQuestion: 'Will Arsenal beat Chelsea?' });
    expect(sport.originalWording).toBeUndefined();
  });
});
