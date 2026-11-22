// Sixth adversary round, set matching. proposeSet used to take only the best price-time maker per other option, so a
// first maker that cannot be left 0 or >= 10 shares hid a later legal one: propose answered nothing although a legal
// mint existed.
import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import type { BookOrder } from '../src/book';
import { propose, type MatchOpts } from '../src/match';
import { modelErrors, type MOrder } from './contract-model';
import { validLeft } from './remainders';

const NOW_S = 1_999_900_000;
const SH = 1_000_000n;
const W = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Hex;
const optsN = (nOptions: number): MatchOpts => ({ nOptions, nowSeconds: NOW_S, blocked: () => false });

function mk(seq: number, maker: number, option: number, price: number, shares: number): BookOrder {
  const size = BigInt(shares) * SH;
  return {
    seq, hash: `0x${seq.toString(16).padStart(64, '0')}` as Hex, salt: 1n, marketId: 1n, expiration: 2_000_000_000n, nonce: 0n,
    signature: '0x11' as Hex, fee: 0n, createdAt: 0, size, filled: 0n, remaining: size, maker: W(maker), option, isBuy: true, price, inFlight: false,
  } as unknown as BookOrder;
}
const model = (o: BookOrder): MOrder => ({ maker: o.maker, marketId: o.marketId, option: o.option, isBuy: o.isBuy, price: o.price, size: o.size });

describe('adv6 set: a legal mint exists, so propose must not answer nothing', () => {
  it('5-share taker, option-1 buys of 13 then 5 shares at 30: the second maker fills the mint whole', () => {
    const early = mk(1, 2, 1, 30, 13);
    const late = mk(2, 3, 1, 30, 5);
    const taker = mk(100, 1, 0, 70, 5); // pays 100 - 30 = 70
    const p = propose(taker, [early, late, taker], optsN(2));
    expect(p, 'late maker alone gives a legal mint (taker 0 left, maker 0 left)').not.toBeNull();
    expect(p!.kind).toBe('mint');
    expect(modelErrors(model(taker), p!.makers.map(model), p!.fills, p!.takerFill, 2, () => false)).toBeNull();
    expect(validLeft(taker.remaining - p!.takerFill)).toBe(true);
    p!.makers.forEach((m, i) => expect(validLeft(m.remaining - p!.fills[i])).toBe(true));
  });
});

describe('adv6 set: fuzz, propose answers whenever any legal set match exists (up to 4 makers per option)', () => {
  let rs = 4242;
  const rnd = (n: number) => {
    rs = (rs * 1103515245 + 12345) & 0x7fffffff;
    return (rs >> 8) % n;
  };
  const valid = (l: number) => l === 0 || l >= 10;
  function legalExists(T: number, tLimit: number, perOpt: { price: number; size: number }[][]): boolean {
    const pick = (i: number, sum: number, sizes: number[]): boolean => {
      if (i === perOpt.length) {
        if (sum > 100 || 100 - sum > tLimit) return false;
        const hi = Math.min(T, ...sizes);
        for (let f = 1; f <= hi; f++) if (valid(T - f) && sizes.every((s) => valid(s - f))) return true;
        return false;
      }
      return perOpt[i].some((m) => pick(i + 1, sum + m.price, [...sizes, m.size]));
    };
    return pick(0, 0, []);
  }
  it('no book has a legal mint that propose misses', () => {
    const misses: string[] = [];
    for (let i = 0; i < 20000; i++) {
      const nOptions = 2 + rnd(2);
      const T = 1 + rnd(40);
      const tLimit = 40 + rnd(60);
      const perOpt: { price: number; size: number }[][] = [];
      const book: BookOrder[] = [];
      let seq = 1;
      for (let o = 1; o < nOptions; o++) {
        const k = 1 + rnd(4);
        const ms = Array.from({ length: k }, () => ({ price: 20 + 10 * rnd(3), size: 1 + rnd(30) }));
        perOpt.push(ms);
        for (const m of ms) {
          book.push(mk(seq, seq + 1, o, m.price, m.size));
          seq++;
        }
      }
      const taker = mk(1000, 1, 0, tLimit, T);
      const p = propose(taker, [...book, taker], optsN(nOptions));
      if (!p && legalExists(T, tLimit, perOpt)) misses.push(JSON.stringify({ nOptions, T, tLimit, perOpt }));
      if (p) {
        expect(modelErrors(model(taker), p.makers.map(model), p.fills, p.takerFill, nOptions, () => false)).toBeNull();
        expect(validLeft(taker.remaining - p.takerFill)).toBe(true);
        p.makers.forEach((m, j) => expect(validLeft(m.remaining - p.fills[j])).toBe(true));
      }
    }
    expect(misses.length, `legal mints missed (first: ${misses.slice(0, 2).join(' ')})`).toBe(0);
  });
});
