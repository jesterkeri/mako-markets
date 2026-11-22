// Codex MATCHER_SLICE2 R3 F1: the set search tried the largest q first and kept it, so at the same price a later order
// that allowed a larger fill was chosen over an earlier one that a smaller legal fill could use. A set is now ranked by
// price, then time (the makers' arrival compared option by option, in option order), then the larger fill.
import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import type { BookOrder } from '../src/book';
import { propose, proposeSet, type MatchOpts } from '../src/match';
import { modelErrors, type MOrder } from './contract-model';

const SH = 1_000_000n;
const MIN = 10n * SH;
const W = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Hex;

function mk(seq: number, option: number, isBuy: boolean, price: number, shares: number): BookOrder {
  const size = BigInt(shares) * SH;
  return {
    seq, hash: `0x${seq.toString(16).padStart(64, '0')}` as Hex, salt: 1n, marketId: 1n, expiration: 2_000_000_000n, nonce: 0n,
    signature: '0x11' as Hex, fee: 0n, createdAt: 0, size, filled: 0n, remaining: size, maker: W(100 + seq), option, isBuy, price, inFlight: false,
  } as unknown as BookOrder;
}
const opts = (nOptions: number): MatchOpts => ({ nOptions, nowSeconds: 1_999_900_000, blocked: () => false });
const model = (o: BookOrder): MOrder => ({ maker: o.maker, marketId: o.marketId, option: o.option, isBuy: o.isBuy, price: o.price, size: o.size });
const legalLeft = (rem: bigint, f: bigint) => f > 0n && f <= rem && (rem === f || rem - f >= MIN);

function set(taker: BookOrder, book: BookOrder[], n = 3) {
  const p = proposeSet(taker, [...book, taker], opts(n));
  expect(p).not.toBeNull();
  expect(modelErrors(model(p!.taker), p!.makers.map(model), p!.fills, p!.takerFill, n, () => false)).toBeNull();
  expect(legalLeft(p!.taker.remaining, p!.takerFill)).toBe(true);
  p!.makers.forEach((m, i) => expect(legalLeft(m.remaining, p!.fills[i])).toBe(true));
  return { seqs: p!.makers.map((m) => m.seq), fill: p!.takerFill / SH, price: p!.takerPrice };
}

describe('Codex R3 F1: an earlier order at the same price is not passed over for a larger fill', () => {
  it('mint: an older 10-share bid at 25 beats a newer 20-share bid at 25 (fill 10, not 20)', () => {
    // taker buys 20 of option 0 at up to 50; option 1: older 10 @25 (seq 1), newer 20 @25 (seq 2); option 2: 20 @25
    const book = [mk(1, 1, true, 25, 10), mk(2, 1, true, 25, 20), mk(3, 2, true, 25, 20)];
    expect(set(mk(10, 0, true, 50, 20), book)).toEqual({ seqs: [1, 3], fill: 10n, price: 50 });
  });

  it('merge: the same with sells (an older 10-share ask beats a newer 20-share ask at the same price)', () => {
    const book = [mk(1, 1, false, 25, 10), mk(2, 1, false, 25, 20), mk(3, 2, false, 25, 20)];
    expect(set(mk(10, 0, false, 50, 20), book)).toEqual({ seqs: [1, 3], fill: 10n, price: 50 });
  });

  it('through propose too: the set it hands on keeps the earlier maker', () => {
    const book = [mk(1, 1, true, 25, 10), mk(2, 1, true, 25, 20), mk(3, 2, true, 25, 20)];
    const taker = mk(10, 0, true, 50, 20);
    const p = propose(taker, [...book, taker], opts(3));
    expect(p?.kind).toBe('mint');
    expect(p!.makers.map((m) => m.seq)).toEqual([1, 3]);
  });

  it('unequal same-price sizes: an older 30-share bid takes the whole 20 (earliest and largest agree)', () => {
    const book = [mk(1, 1, true, 25, 30), mk(2, 1, true, 25, 20), mk(3, 2, true, 25, 20)];
    expect(set(mk(10, 0, true, 50, 20), book)).toEqual({ seqs: [1, 3], fill: 20n, price: 50 });
  });

  it('an earlier order that no legal fill can use is passed over (10 shares whole would leave the 15-share taker 5)', () => {
    const book = [mk(1, 1, true, 25, 10), mk(2, 1, true, 25, 15), mk(3, 2, true, 25, 15)];
    expect(set(mk(10, 0, true, 50, 15), book)).toEqual({ seqs: [2, 3], fill: 15n, price: 50 });
  });

  it('price still comes first: a newer bid at a better price beats an older one', () => {
    // option 1: older 20 @25, newer 20 @30; the taker pays 100 - (30 + 25) = 45 instead of 50
    const book = [mk(1, 1, true, 25, 20), mk(2, 1, true, 30, 20), mk(3, 2, true, 25, 20)];
    expect(set(mk(10, 0, true, 50, 20), book)).toEqual({ seqs: [2, 3], fill: 20n, price: 45 });
  });
});

describe('ties across different sets at the same set price: option order', () => {
  it('mint, best bids overshoot 100: of the two sets summing to 100, the one with the earlier option-1 maker', () => {
    // option 1: 30 (seq 4), 60 (seq 1); option 2: 40 (seq 2), 70 (seq 3). Sums at most 100: 30+40, 30+70 = 100,
    // 60+40 = 100. Between {seq 4, seq 3} and {seq 1, seq 2}, option 1 decides: seq 1.
    const book = [mk(1, 1, true, 60, 20), mk(2, 2, true, 40, 20), mk(3, 2, true, 70, 20), mk(4, 1, true, 30, 20)];
    expect(set(mk(10, 0, true, 30, 20), book)).toEqual({ seqs: [1, 2], fill: 20n, price: 0 });
  });

  it('the first option where two sets differ decides, even if a later option then uses a newer maker', () => {
    // option 1: 60 (seq 3), 30 (seq 2); option 2: 70 (seq 1), 40 (seq 4). Sets at 100: {seq 2, seq 1} and
    // {seq 3, seq 4}: option 1's seq 2 wins.
    const book = [mk(1, 2, true, 70, 20), mk(2, 1, true, 30, 20), mk(3, 1, true, 60, 20), mk(4, 2, true, 40, 20)];
    expect(set(mk(10, 0, true, 30, 20), book)).toEqual({ seqs: [2, 1], fill: 20n, price: 0 });
  });

  it('same makers at two fills: the larger fill', () => {
    const book = [mk(1, 1, true, 25, 40), mk(2, 2, true, 25, 40)];
    expect(set(mk(10, 0, true, 50, 30), book)).toEqual({ seqs: [1, 2], fill: 30n, price: 50 });
  });
});
