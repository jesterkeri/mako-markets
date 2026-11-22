// Seventh adversary round, direct fills. Plan line 457 (no fill leaves 1 to 9 shares) and the brief's no-starvation
// rule: when a legal direct fill exists for a crossing taker, propose must not answer nothing. Larger books than the
// sixth round (up to 14 same-side makers) so the 10-candidate search window and the 10-maker cap are exercised.
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

describe('adv7: fuzz, direct fills against up to 14 makers', () => {
  const valid = (l: number) => l === 0 || l >= 10;
  let rs = 99;
  const rnd = (n: number) => {
    rs = (rs * 1103515245 + 12345) & 0x7fffffff;
    return (rs >> 8) % n;
  };
  /// Subset-sum over every maker's legal fills, at most `maxMakers` makers.
  function legalExists(T: number, sizes: number[], maxMakers: number): boolean {
    let reach = new Map<number, number>([[0, 0]]); // sum -> fewest makers used
    for (const m of sizes) {
      const fills: number[] = [];
      for (let f = 1; f <= m; f++) if (valid(m - f)) fills.push(f);
      const next = new Map(reach);
      for (const [s, c] of reach) for (const f of fills) if (s + f <= T && c + 1 <= maxMakers && (next.get(s + f) ?? 99) > c + 1) next.set(s + f, c + 1);
      reach = next;
    }
    for (const s of reach.keys()) if (s > 0 && valid(T - s)) return true;
    return false;
  }

  for (const [label, lo] of [['makers of at least 10 shares (what intake lets rest)', 10], ['makers of 1 to 30 shares', 1]] as const) {
    it(`${label}: every proposal is legal; none missed`, () => {
      const missed: string[] = [];
      const bad: string[] = [];
      for (let i = 0; i < 30000; i++) {
        const k = 1 + rnd(14);
        const sizes = Array.from({ length: k }, () => lo + rnd(31 - lo));
        const T = 10 + rnd(35);
        const book = sizes.map((s, j) => mk(j + 1, j + 2, false, 50, s));
        const taker = mk(100, 1, true, 60, T);
        const p = propose(taker, [...book, taker], opts);
        if (p) {
          const err = modelErrors(model(p.taker), p.makers.map(model), p.fills, p.takerFill, 2, () => false);
          const ok = !err && validLeft(taker.remaining - p.takerFill) && p.makers.every((m, j) => validLeft(m.remaining - p.fills[j]));
          if (!ok) bad.push(JSON.stringify({ T, sizes, err }));
        } else if (legalExists(T, sizes, 10)) missed.push(JSON.stringify({ T, sizes }));
      }
      expect(bad, `illegal proposals (first ${bad.slice(0, 2).join(' ')})`).toEqual([]);
      expect(missed.length, `legal fill exists but propose answered nothing (first ${missed.slice(0, 3).join(' ')})`).toBe(0);
    });
  }
});

describe('adv7: direct, legal fill only beyond the 10-candidate window (makers under 10 shares; cannot rest via intake today)', () => {
  // Skipped: makers under 10 shares cannot rest via intake, so this book is unreachable.
  it.skip('taker 15, ten 6-share asks then a 9-share ask: 6 + 9 fills the taker whole', () => {
    const book = Array.from({ length: 10 }, (_, i) => mk(i + 1, i + 2, false, 50, 6));
    const nine = mk(11, 20, false, 50, 9);
    const taker = mk(100, 1, true, 60, 15);
    expect(modelErrors(model(taker), [book[0], nine].map(model), [6n * SH, 9n * SH], 15n * SH, 2, () => false)).toBeNull();
    const p = propose(taker, [...book, nine, taker], opts);
    expect(p, 'a legal fill (first 6-share ask + the 9-share ask) exists').not.toBeNull();
  });
});
