// Fifth adversary round, matching. Property check: every proposal is accepted by the contract model, and no share
// in it is filled at a worse price than another option available at the same moment (plan 3.2 price priority).
import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import type { BookOrder } from '../src/book';
import { propose, proposeDirect, proposeSet, type MatchOpts } from '../src/match';
import { modelErrors, type MOrder } from './contract-model';
import { pairTradable, validLeft } from './remainders';

const NOW_S = 1_999_900_000;
// [rule fix] one size unit is 2.5 shares, so random orders straddle the 10-share minimum
const LOT = 2_500_000n;
const W = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Hex;

let rs = 12345;
const rnd = (n: number) => {
  rs = (rs * 1103515245 + 12345) & 0x7fffffff;
  return (rs >> 8) % n;
};

function mk(seq: number, maker: number, option: number, isBuy: boolean, price: number, lots: number): BookOrder {
  const size = BigInt(lots) * LOT;
  return {
    seq, hash: `0x${seq.toString(16).padStart(64, '0')}` as Hex, salt: 1n, marketId: 1n, expiration: 2_000_000_000n, nonce: 0n,
    signature: '0x11' as Hex, fee: 0n, createdAt: 0, size, filled: 0n, remaining: size, maker: W(maker), option, isBuy, price, inFlight: false,
  } as unknown as BookOrder;
}
const J = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
const model = (o: BookOrder): MOrder => ({ maker: o.maker, marketId: o.marketId, option: o.option, isBuy: o.isBuy, price: o.price, size: o.size });

describe('adv5: price priority and contract validity of every proposal (fuzz)', () => {
  it('no proposal fills at a worse price than the best direct or set option, and the model accepts it', () => {
    for (let iter = 0; iter < 20000; iter++) {
      const nOptions = 2 + rnd(3);
      const book: BookOrder[] = [];
      const n = 2 + rnd(9);
      for (let i = 0; i < n; i++) book.push(mk(i + 1, 1 + rnd(8), rnd(nOptions), rnd(2) === 0, 1 + rnd(99), 1 + rnd(5)));
      const taker = mk(100, 20, rnd(nOptions), rnd(2) === 0, 1 + rnd(99), 1 + rnd(12));
      const opts: MatchOpts = { nOptions, nowSeconds: NOW_S, blocked: () => false };
      const all = [...book, taker];
      const p = propose(taker, all, opts);
      const d = proposeDirect(taker, all, opts);
      const s = proposeSet(taker, all, opts);
      if (!p) {
        expect(d === null && s === null, J({ nOptions, all })).toBe(true);
        continue;
      }
      const err = modelErrors(model(p.taker), p.makers.map(model), p.fills, p.takerFill, nOptions, () => false);
      expect(err, J({ nOptions, all, p })).toBeNull();
      const worseThan = (a: number, b: number) => (taker.isBuy ? a > b : a < b);
      const prices = p.kind === 'direct' ? p.makers.map((m) => m.price) : [p.takerPrice];
      if (d && p.kind !== 'direct') for (const x of prices) expect(worseThan(x, d.makers[0].price), `vs direct ${J({ nOptions, all, p })}`).toBe(false);
      if (s) for (const x of prices) expect(worseThan(x, s.takerPrice), `vs set ${J({ nOptions, all, p })}`).toBe(false);
      expect(p.takerFill > 0n).toBe(true);
    }
  });
});

describe('adv5: repeated passes drain every crossing pair and terminate (no starvation)', () => {
  it('applying each proposal as the settler would leaves no crossed direct pair', () => {
    for (let iter = 0; iter < 3000; iter++) {
      const nOptions = 2 + rnd(5);
      const book: BookOrder[] = [];
      const n = 3 + rnd(25);
      for (let i = 0; i < n; i++) book.push(mk(i + 1, 1 + rnd(5), rnd(nOptions), rnd(2) === 0, 1 + rnd(99), 1 + rnd(30)));
      const opts: MatchOpts = { nOptions, nowSeconds: NOW_S, blocked: () => false };
      let guard = 0;
      for (;;) {
        expect(++guard, 'no termination ' + J(book)).toBeLessThan(5000);
        const live = book.filter((o) => o.remaining > 0n);
        const takers = [...live].sort((a, b) => b.seq - a.seq);
        let p: ReturnType<typeof propose> = null;
        for (const t of takers) {
          p = propose(t, live, opts);
          if (p) break;
        }
        if (!p) break;
        const err = modelErrors(model(p.taker), p.makers.map(model), p.fills, p.takerFill, nOptions, () => false);
        expect(err, J(p)).toBeNull();
        const q = p;
        const apply = (o: BookOrder, f: bigint) => {
          o.remaining -= f;
          o.filled += f;
        };
        expect(validLeft(q.taker.remaining - q.takerFill), 'taker left 1 to 9 shares ' + J(q)).toBe(true);
        q.makers.forEach((m, i) => expect(validLeft(m.remaining - q.fills[i]), 'maker left 1 to 9 shares ' + J(q)).toBe(true));
        apply(q.taker, q.takerFill);
        q.makers.forEach((m, i) => apply(m, q.fills[i]));
        for (const o of book) expect(o.remaining >= 0n && o.filled <= o.size).toBe(true);
      }
      for (const t of book) {
        if (t.remaining <= 0n) continue;
        for (const m of book) {
          if (m.remaining <= 0n || m.seq >= t.seq || m.maker === t.maker || m.option !== t.option || m.isBuy === t.isBuy) continue;
          const crossed = (t.isBuy ? m.price <= t.price : m.price >= t.price) && pairTradable(t.remaining, m.remaining);
          expect(crossed, 'left crossed ' + J({ t, m })).toBe(false);
        }
      }
    }
  });
});
