// Sixth adversary round, matching. Plan 2 table (line 457) "no fill leaves 1 to 9 shares" and the no-starvation rule:
// when a legal direct fill exists for a crossing taker, propose must not answer nothing. The greedy price-time pass
// gives each maker the most it can take, so an earlier maker can use up the budget in a way that leaves the taker or a
// later maker with 1 to 9 shares, and the second pass (budget = remaining - 10 shares) cannot repair that.
import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import type { BookOrder } from '../src/book';
import { propose, type MatchOpts } from '../src/match';
import { modelErrors, type MOrder } from './contract-model';
import { validLeft } from './remainders';

const NOW_S = 1_999_900_000;
const SH = 1_000_000n;
const W = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Hex;
const opts: MatchOpts = { nOptions: 2, nowSeconds: NOW_S, blocked: () => false };

function mk(seq: number, maker: number, isBuy: boolean, price: number, shares: number): BookOrder {
  const size = BigInt(shares) * SH;
  return {
    seq, hash: `0x${seq.toString(16).padStart(64, '0')}` as Hex, salt: 1n, marketId: 1n, expiration: 2_000_000_000n, nonce: 0n,
    signature: '0x11' as Hex, fee: 0n, createdAt: 0, size, filled: 0n, remaining: size, maker: W(maker), option: 0, isBuy, price, inFlight: false,
  } as unknown as BookOrder;
}
const model = (o: BookOrder): MOrder => ({ maker: o.maker, marketId: o.marketId, option: o.option, isBuy: o.isBuy, price: o.price, size: o.size });

/// A hand-written legal fill of a buy taker against same-price sells: the contract model accepts it and every party
/// ends with 0 or at least 10 shares. `makerFills` are in whole shares; their sum is the taker's fill.
function assertLegal(taker: BookOrder, makers: BookOrder[], makerFills: number[]) {
  const fills = makerFills.map((f) => BigInt(f) * SH);
  const tf = fills.reduce((a, b) => a + b, 0n);
  expect(modelErrors(model(taker), makers.map(model), fills, tf, 2, () => false)).toBeNull();
  expect(validLeft(taker.remaining - tf)).toBe(true);
  makers.forEach((m, i) => expect(validLeft(m.remaining - fills[i])).toBe(true));
}

describe('adv6: a legal direct fill exists, so propose must not answer nothing (plan 2 line 457 + no starvation)', () => {
  it('5-share taker, makers of 13 then 3 shares: 2 + 3 fills the taker whole and leaves 11 and 0', () => {
    const early = mk(1, 2, false, 50, 13);
    const late = mk(2, 3, false, 50, 3);
    const taker = mk(100, 1, true, 60, 5);
    assertLegal(taker, [early, late], [2, 3]);
    const p = propose(taker, [early, late, taker], opts);
    expect(p, 'a legal whole fill of the taker exists (13 -> 11 left, 3 -> 0 left)').not.toBeNull();
    expect(validLeft(taker.remaining - p!.takerFill)).toBe(true);
    p!.makers.forEach((m, i) => expect(validLeft(m.remaining - p!.fills[i])).toBe(true));
  });

  it('exactly 10-share taker, makers of 4, 14 and 10 shares: the 10-share maker fills it whole', () => {
    const a = mk(1, 2, false, 50, 4);
    const b = mk(2, 3, false, 50, 14);
    const c = mk(3, 4, false, 50, 10);
    const taker = mk(100, 1, true, 60, 10);
    assertLegal(taker, [c], [10]);
    const p = propose(taker, [a, b, c, taker], opts);
    expect(p, 'maker c alone fills the taker exactly (0 left each)').not.toBeNull();
  });
});

describe('adv6: fuzz, propose answers something whenever any legal direct fill exists', () => {
  const valid = (l: number) => l === 0 || l >= 10;
  let rs = 777;
  const rnd = (n: number) => {
    rs = (rs * 1103515245 + 12345) & 0x7fffffff;
    return (rs >> 8) % n;
  };
  /// A legal fill (sum > 0, taker left valid) is reachable by subset-summing each maker's legal fills.
  function legalExists(T: number, sizes: number[]): boolean {
    let reach = new Set<number>([0]);
    for (const m of sizes) {
      const fills: number[] = [];
      for (let f = 1; f <= m; f++) if (valid(m - f)) fills.push(f);
      const next = new Set(reach);
      for (const s of reach) for (const f of fills) if (s + f <= T) next.add(s + f);
      reach = next;
    }
    for (const s of reach) if (s > 0 && valid(T - s)) return true;
    return false;
  }
  it('no book of up to 5 same-price makers has a legal fill that propose misses', () => {
    const misses: string[] = [];
    for (let i = 0; i < 40000; i++) {
      const k = 1 + rnd(5);
      const sizes = Array.from({ length: k }, () => 1 + rnd(30));
      const T = 1 + rnd(40);
      const book = sizes.map((s, j) => mk(j + 1, j + 2, false, 50, s));
      const taker = mk(100, 1, true, 60, T);
      const p = propose(taker, [...book, taker], opts);
      if (!p && legalExists(T, sizes)) misses.push(JSON.stringify({ T, sizes }));
    }
    expect(misses.length, `books with a legal fill but no proposal (first: ${misses.slice(0, 3).join(' ')})`).toBe(0);
  });
});
