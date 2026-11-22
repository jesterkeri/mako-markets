// Seventh adversary round, set matches (mint) and direct fills. Plan line 457 (no fill leaves 1 to 9 shares), plan 3.2 /
// 4.4 (SetPriceSum, PriceNotCrossed), brief: no starvation, price-time priority. Every proposal is also judged by the
// contract model, and every "no proposal" answer is checked against a brute-force search written here.
import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import type { BookOrder } from '../src/book';
import { propose, type MatchOpts } from '../src/match';
import { modelErrors, type MOrder } from './contract-model';
import { validLeft } from './remainders';

const NOW_S = 1_999_900_000;
const SH = 1_000_000n;
const W = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Hex;

function mk(seq: number, maker: number, option: number, isBuy: boolean, price: number, shares: number): BookOrder {
  const size = BigInt(shares) * SH;
  return {
    seq, hash: `0x${seq.toString(16).padStart(64, '0')}` as Hex, salt: 1n, marketId: 1n, expiration: 2_000_000_000n, nonce: 0n,
    signature: '0x11' as Hex, fee: 0n, createdAt: 0, size, filled: 0n, remaining: size, maker: W(maker), option, isBuy, price, inFlight: false,
  } as unknown as BookOrder;
}
const model = (o: BookOrder): MOrder => ({ maker: o.maker, marketId: o.marketId, option: o.option, isBuy: o.isBuy, price: o.price, size: o.size });
const opts3: MatchOpts = { nOptions: 3, nowSeconds: NOW_S, blocked: () => false };

/// A fill f (whole shares) is legal for a party with `rem` shares when it leaves 0 or at least 10.
const okLeft = (rem: number, f: number) => rem - f === 0 || rem - f >= 10;

describe('adv7: mint, a legal set exists beyond the first 4 makers of an option', () => {
  it('taker 15 shares; four 10-share bids ahead on option 1 cannot take 15, the 5th (15 shares) can', () => {
    // Option 0 taker buys 15 shares at up to 60. Mint partners: one resting BUY on option 1 and one on option 2.
    // A 10-share partner can only fill whole (10), which leaves the taker 5 shares: illegal. 10-share orders are the
    // smallest legal resting size, so four of them at the best price are an ordinary book.
    const book: BookOrder[] = [];
    let seq = 1;
    for (let i = 0; i < 4; i++) book.push(mk(seq++, 10 + i, 1, true, 30, 10));
    const good1 = mk(seq++, 20, 1, true, 29, 15); // option 1, worse price, 15 shares
    const good2 = mk(seq++, 21, 2, true, 30, 15); // option 2, 15 shares
    book.push(good1, good2);
    const taker = mk(100, 1, 0, true, 60, 15);
    // 30 + 29... sum = 29 + 30 = 59 <= 100, taker pays 41 <= 60
    const fills = [15n * SH, 15n * SH];
    expect(modelErrors(model(taker), [good1, good2].map(model), fills, 15n * SH, 3, () => false)).toBeNull();
    expect(validLeft(taker.remaining - 15n * SH)).toBe(true);
    const p = propose(taker, [...book, taker], opts3);
    expect(p, 'a legal mint (good1 + good2, 15 shares each, everyone left with 0) exists').not.toBeNull();
  });
});

describe('adv7: mint price priority', () => {
  it('chooses the best-priced legal set, not the first legal one in enumeration order', () => {
    // 3 options, taker buys on option 0 and pays 100 - (A + B); a higher maker sum is better for the taker.
    // Taker 40 shares. A1(50, 8sh) B1(50, 12sh): illegal together (8 whole forces the 12-share maker to 4 left).
    // A1 with B2(40, 8sh) is legal (sum 90). A2(45, 20sh) with B1(50, 12sh) is legal (sum 95, fill 2 shares).
    const A1 = mk(1, 10, 1, true, 50, 8);
    const A2 = mk(2, 11, 1, true, 45, 20);
    const B1 = mk(3, 12, 2, true, 50, 12);
    const B2 = mk(4, 13, 2, true, 40, 8);
    const taker = mk(100, 1, 0, true, 60, 40);
    const legal = (a: BookOrder, b: BookOrder) => {
      const fills = [2n * SH, 2n * SH];
      return modelErrors(model(taker), [a, b].map(model), fills, 2n * SH, 3, () => false) === null;
    };
    expect(legal(A2, B1)).toBe(true);
    const p = propose(taker, [A1, A2, B1, B2, taker], opts3);
    expect(p).not.toBeNull();
    const sum = p!.makers.reduce((a, m) => a + m.price, 0);
    expect(p!.takerPrice, `proposal pays ${p!.takerPrice} (makers sum ${sum}); the legal set A2+B1 pays 5`).toBe(5);
  });
});

describe('adv7: fuzz, 3-option mint and direct, whole-share books with every order at least 10 shares', () => {
  let rs = 4242;
  const rnd = (n: number) => {
    rs = (rs * 1103515245 + 12345) & 0x7fffffff;
    return (rs >> 8) % n;
  };

  /// Brute force: does any legal mint exist with up to `cap` best makers per option (cap = all).
  function legalMint(taker: BookOrder, book: BookOrder[], cap: number): boolean {
    const tr = Number(taker.remaining / SH);
    const per = [1, 2].map((opt) =>
      book.filter((o) => o.option === opt && o.isBuy && o.seq < taker.seq).sort((a, b) => b.price - a.price || a.seq - b.seq).slice(0, cap),
    );
    for (const a of per[0]) for (const b of per[1]) {
      const sum = a.price + b.price;
      if (sum > 100 || 100 - sum > taker.price) continue;
      const ra = Number(a.remaining / SH), rb = Number(b.remaining / SH);
      const hi = Math.min(tr, ra, rb);
      for (let f = 1; f <= hi; f++) if (okLeft(tr, f) && okLeft(ra, f) && okLeft(rb, f)) return true;
    }
    return false;
  }

  it('every proposal passes the contract model and the 1-to-9 rule; a legal mint is never answered with nothing', () => {
    const bad: string[] = [];
    const missed: string[] = [];
    for (let i = 0; i < 6000; i++) {
      const book: BookOrder[] = [];
      let seq = 1;
      const n1 = 1 + rnd(7), n2 = 1 + rnd(7);
      for (let j = 0; j < n1; j++) book.push(mk(seq++, 10 + j, 1, true, 20 + rnd(30), 10 + rnd(12)));
      for (let j = 0; j < n2; j++) book.push(mk(seq++, 30 + j, 2, true, 20 + rnd(30), 10 + rnd(12)));
      const taker = mk(100, 1, 0, true, 50 + rnd(40), 10 + rnd(15));
      const all = [...book, taker];
      const p = propose(taker, all, opts3);
      const snapshot = JSON.stringify(all.map((o) => [o.seq, o.remaining.toString()]));
      void snapshot;
      if (p) {
        const err = modelErrors(model(p.taker), p.makers.map(model), p.fills, p.takerFill, 3, () => false);
        const left = [p.taker.remaining - p.takerFill, ...p.makers.map((m, k) => m.remaining - p.fills[k])];
        if (err || left.some((l) => !validLeft(l))) bad.push(`${err} ${JSON.stringify({ T: taker.remaining / SH, p: taker.price, book: book.map((o) => [o.option, o.price, o.remaining / SH]) }, (_, v) => (typeof v === 'bigint' ? Number(v) : v))}`);
      } else if (legalMint(taker, book, 100)) {
        // legal set exists somewhere in the book; classify whether it needs a maker outside the top 4 per option
        const inWindow = legalMint(taker, book, 4);
        missed.push(`${inWindow ? 'IN-WINDOW' : 'BEYOND-4'} ${JSON.stringify({ T: Number(taker.remaining / SH), p: taker.price, book: book.map((o) => [o.option, o.price, Number(o.remaining / SH)]) })}`);
      }
    }
    expect(bad, `illegal proposals (first: ${bad.slice(0, 2).join(' | ')})`).toEqual([]);
    expect(missed.length, `books with a legal mint but no proposal (first: ${missed.slice(0, 3).join(' | ')})`).toBe(0);
  });
});
