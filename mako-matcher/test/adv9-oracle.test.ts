// Adversary R9: a brute-force oracle for set ranking that shares no code with src/. It enumerates every one-maker-per-
// option combination, takes each combination's largest legal common fill by scanning lots downward, drops what the
// spec forbids (price sum over 100, taker limit, arrival after the taker, 1 to 9 shares left), then ranks by taker
// price, then the makers' seq compared option by option, then the larger fill.
import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import type { BookOrder } from '../src/book';
import { proposeSet, type MatchOpts } from '../src/match';

const LOT = 10_000n;
const SH = 1_000_000n;
const TEN = 10n * SH;
const W = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Hex;

function mk(seq: number, option: number, isBuy: boolean, price: number, size: bigint): BookOrder {
  return {
    seq, hash: `0x${seq.toString(16).padStart(64, '0')}` as Hex, salt: 1n, marketId: 1n, expiration: 2_000_000_000n, nonce: 0n,
    signature: '0x11' as Hex, fee: 0n, createdAt: 0, size, filled: 0n, remaining: size, maker: W(100 + seq), option, isBuy, price, inFlight: false,
  } as unknown as BookOrder;
}

let state = 0x9e3779b9;
const rnd = (n: number) => {
  state ^= state << 13; state >>>= 0;
  state ^= state >>> 17;
  state ^= state << 5; state >>>= 0;
  return state % n;
};

const legal = (rem: bigint, q: bigint) => q > 0n && q <= rem && (rem === q || rem - q >= TEN);

function oracle(taker: BookOrder, book: BookOrder[], n: number) {
  const opts: BookOrder[][] = [];
  for (let o = 0; o < n; o++) {
    if (o === taker.option) continue;
    opts.push(book.filter((b) => b.option === o && b.isBuy === taker.isBuy && b.seq < taker.seq));
  }
  let best: { seqs: number[]; q: bigint; price: number } | null = null;
  const pick: BookOrder[] = [];
  const rec = (i: number) => {
    if (i === opts.length) {
      const sum = pick.reduce((a, b) => a + b.price, 0);
      if (sum > 100) return;
      const price = 100 - sum;
      if (taker.isBuy ? price > taker.price : price < taker.price) return;
      let q = taker.remaining;
      while (q >= LOT && !(legal(taker.remaining, q) && pick.every((m) => legal(m.remaining, q)))) q -= LOT;
      if (q < LOT) return;
      const seqs = pick.map((m) => m.seq);
      if (best === null) { best = { seqs, q, price }; return; }
      const better = taker.isBuy ? price < best.price : price > best.price;
      if (better) { best = { seqs, q, price }; return; }
      if (price !== best.price) return;
      for (let k = 0; k < seqs.length; k++) {
        if (seqs[k] !== best.seqs[k]) {
          if (seqs[k] < best.seqs[k]) best = { seqs, q, price };
          return;
        }
      }
    }
    for (const m of opts[i]) {
      pick.push(m);
      rec(i + 1);
      pick.pop();
    }
  };
  if (opts.every((o) => o.length > 0)) rec(0);
  return best as { seqs: number[]; q: bigint; price: number } | null;
}

const stats = { total: 0, some: 0, mint: 0 };
const size = () => BigInt(10 + rnd(7)) * SH + BigInt(rnd(4) === 0 ? rnd(100) : 0) * LOT;

function run(cases: number, isBuy: boolean, shape: () => { n: number; lo: number; hi: number; count: number; takerPrice: number }) {
  for (let c = 0; c < cases; c++) {
    const { n, lo, hi, count, takerPrice } = shape();
    const book: BookOrder[] = [];
    for (let i = 1; i <= count; i++) book.push(mk(i, rnd(n), isBuy, lo + rnd(hi - lo + 1), size()));
    const taker = mk(count + 1, rnd(n), isBuy, takerPrice, size());
    const opts: MatchOpts = { nOptions: n, nowSeconds: 1_999_900_000, blocked: () => false };
    const want = oracle(taker, book, n);
    const got = proposeSet(taker, [...book, taker], opts);
    const desc = JSON.stringify({ c, n, taker: [taker.option, taker.price, String(taker.remaining)], book: book.map((b) => [b.seq, b.option, b.price, String(b.remaining)]) });
    if (want === null) {
      expect(got, desc).toBeNull();
    } else {
      expect(got, desc).not.toBeNull();
      expect({ seqs: got!.makers.map((m) => m.seq), q: got!.takerFill, price: got!.takerPrice }, desc).toEqual(want);
    }
  }
}

describe('set ranking against a brute-force oracle', () => {
  for (const isBuy of [true, false]) {
    it(`${isBuy ? 'mint' : 'merge'}: 4000 random books of 3 to 5 options`, () => {
      run(4000, isBuy, () => ({
        n: 3 + rnd(3), lo: isBuy ? 15 + rnd(10) : 1, hi: isBuy ? 45 + rnd(15) : 40, count: 4 + rnd(10), takerPrice: isBuy ? 30 + rnd(70) : 1 + rnd(40),
      }));
    });
    it(`${isBuy ? 'mint' : 'merge'}: two options, and 6 to 11 options with small prices`, () => {
      run(1500, isBuy, () => ({ n: 2, lo: 1 + rnd(40), hi: 50 + rnd(49), count: 3 + rnd(6), takerPrice: isBuy ? 1 + rnd(99) : 1 + rnd(60) }));
      run(60, isBuy, () => {
        const n = 6 + rnd(6);
        return { n, lo: 1, hi: 8 + rnd(10), count: 2 * n + rnd(2 * n), takerPrice: isBuy ? 1 + rnd(99) : 1 + rnd(30) };
      });
    });
  }
});
