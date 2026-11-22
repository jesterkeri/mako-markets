// Codex MATCHER_SLICE2 R2 F1: a fixed search window (32 makers per option for three options, 10 candidates for a direct
// fill) left reachable legal matches unproposed on every pass, and let a worse direct price win over a missed set.
// Both searches are now exact over the book. These tests pin Codex's scenarios, a direct fill beyond the old
// window, and compare propose with brute-force searches written here (every set combination; every direct
// assignment over small books) that share no code with src/match.ts. Every proposal is also judged by the contract
// model and the remainder rule (no fill leaves 1 to 9 shares).
import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import type { BookOrder } from '../src/book';
import { propose, proposeDirect, proposeSet, type MatchOpts, type Proposal } from '../src/match';
import { modelErrors, type MOrder } from './contract-model';

const NOW_S = 1_999_900_000;
const SH = 1_000_000n;
const LOT = 10_000n;
const MIN = 10n * SH;
const W = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Hex;

/// `size` in base units (1 share = 10^6).
function mk(seq: number, maker: number, option: number, isBuy: boolean, price: number, size: bigint): BookOrder {
  return {
    seq, hash: `0x${seq.toString(16).padStart(64, '0')}` as Hex, salt: 1n, marketId: 1n, expiration: 2_000_000_000n, nonce: 0n,
    signature: '0x11' as Hex, fee: 0n, createdAt: 0, size, filled: 0n, remaining: size, maker: W(maker), option, isBuy, price, inFlight: false,
  } as unknown as BookOrder;
}
const model = (o: BookOrder): MOrder => ({ maker: o.maker, marketId: o.marketId, option: o.option, isBuy: o.isBuy, price: o.price, size: o.size });
const opts = (nOptions: number): MatchOpts => ({ nOptions, nowSeconds: NOW_S, blocked: () => false });
const legalLeft = (rem: bigint, f: bigint) => f > 0n && f <= rem && (rem === f || rem - f >= MIN);

/// The proposal passes the contract model and leaves no party with 1 to 9 shares.
function sound(p: Proposal, n: number): void {
  expect(modelErrors(model(p.taker), p.makers.map(model), p.fills, p.takerFill, n, () => false)).toBeNull();
  expect(legalLeft(p.taker.remaining, p.takerFill)).toBe(true);
  p.makers.forEach((m, i) => expect(legalLeft(m.remaining, p.fills[i]), `maker ${i}`).toBe(true));
  if (p.kind === 'direct') expect(p.fills.reduce((a, b) => a + b, 0n)).toBe(p.takerFill);
}

/// Deterministic pseudo-random numbers for the fuzz loops.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('Codex R2 F1: a legal set beyond the old 32-maker window', () => {
  // Three options. Taker buys 15 shares of option 0 at up to 50. Option 1: 32 earlier 10-share bids at 25 (each can
  // only fill whole: 10 would leave the taker 5), then a 15-share bid at 25. Option 2: a 15-share bid at 25.
  function book(): { taker: BookOrder; all: BookOrder[]; good: BookOrder[] } {
    const all: BookOrder[] = [];
    let seq = 1;
    for (let i = 0; i < 32; i++) all.push(mk(seq++, 100 + i, 1, true, 25, 10n * SH));
    const g1 = mk(seq++, 200, 1, true, 25, 15n * SH);
    const g2 = mk(seq++, 201, 2, true, 25, 15n * SH);
    all.push(g1, g2);
    const taker = mk(1000, 1, 0, true, 50, 15n * SH);
    return { taker, all: [...all, taker], good: [g1, g2] };
  }

  it('proposes the 15-share mint on the first pass', () => {
    const { taker, all, good } = book();
    const p = propose(taker, all, opts(3));
    expect(p).not.toBeNull();
    sound(p!, 3);
    expect(p!.kind).toBe('mint');
    expect(p!.makers.map((m) => m.seq)).toEqual(good.map((m) => m.seq));
    expect(p!.takerFill).toBe(15n * SH);
    expect(p!.takerPrice).toBe(50);
  });

  it('an unchanged book gets the same match on every pass (nothing to wait for)', () => {
    const { taker, all } = book();
    const a = propose(taker, all, opts(3));
    const b = propose(taker, all, opts(3));
    expect(a).not.toBeNull();
    expect(b!.makers.map((m) => m.seq)).toEqual(a!.makers.map((m) => m.seq));
  });

  it('with a worse direct ask at 60 and a taker limit of 70, the set at 50 wins', () => {
    const { all } = book();
    const taker = mk(1000, 1, 0, true, 70, 15n * SH);
    const ask = mk(500, 300, 0, false, 60, 15n * SH);
    const p = propose(taker, [...all.filter((o) => o.seq !== 1000), ask, taker], opts(3));
    expect(p).not.toBeNull();
    sound(p!, 3);
    expect(p!.kind).toBe('mint');
    expect(p!.takerPrice).toBe(50);
  });

  it('a direct ask at 50 ties the set and wins (tie goes to direct)', () => {
    const { all } = book();
    const taker = mk(1000, 1, 0, true, 70, 15n * SH);
    const ask = mk(500, 300, 0, false, 50, 15n * SH);
    const p = propose(taker, [...all.filter((o) => o.seq !== 1000), ask, taker], opts(3));
    expect(p!.kind).toBe('direct');
    expect(p!.makers[0].seq).toBe(500);
  });
});

describe('mint with best bids summing above 100 (SetPriceSum)', () => {
  it('picks the highest sum that fits, not an overshooting one', () => {
    // Option 1 bids 60 and 40; option 2 bids 60. 60 + 60 = 120 is refused; 40 + 60 = 100 fits (taker pays 0).
    const b1 = mk(1, 10, 1, true, 60, 20n * SH);
    const b2 = mk(2, 11, 1, true, 40, 20n * SH);
    const c1 = mk(3, 12, 2, true, 60, 20n * SH);
    const taker = mk(100, 1, 0, true, 30, 20n * SH);
    const p = proposeSet(taker, [b1, b2, c1, taker], opts(3));
    expect(p).not.toBeNull();
    sound(p!, 3);
    expect(p!.makers.map((m) => m.seq)).toEqual([2, 3]);
    expect(p!.takerPrice).toBe(0);
  });
});

describe('direct: a legal fill needing a maker beyond the old 10-candidate window', () => {
  it('taker 10 shares; ten asks of 10.5 shares (0.5 each to spare) then a 20-share ask', () => {
    // Greedy takes 0.5 share from each of the first ten (MAX_MAKERS) = 5 shares, leaving the taker 5: illegal. Taking
    // 10 shares short of the taker is nothing. A whole fill exists: nine 0.5-share fills plus 5.5 from the 20-share
    // ask (left 14.5).
    const asks: BookOrder[] = [];
    for (let i = 0; i < 10; i++) asks.push(mk(i + 1, 10 + i, 0, false, 50, 10n * SH + SH / 2n));
    const big = mk(20, 50, 0, false, 55, 20n * SH);
    const taker = mk(100, 1, 0, true, 60, 10n * SH);
    const p = proposeDirect(taker, [...asks, big, taker], opts(2));
    expect(p).not.toBeNull();
    sound(p!, 2);
    expect(p!.takerFill).toBe(10n * SH);
    // Earlier makers keep priority: the first nine give all they can spare.
    expect(p!.makers.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 20]);
    expect(p!.fills.slice(0, 9).every((f) => f === SH / 2n)).toBe(true);
    expect(p!.fills[9]).toBe(5n * SH + SH / 2n);
  });

  it('eleven 10-share asks then a 15-share ask for a 15-share taker (whole fills only up front)', () => {
    const asks: BookOrder[] = [];
    for (let i = 0; i < 11; i++) asks.push(mk(i + 1, 10 + i, 0, false, 40, 10n * SH));
    const big = mk(30, 60, 0, false, 45, 15n * SH);
    const taker = mk(100, 1, 0, true, 60, 15n * SH);
    const p = propose(taker, [...asks, big, taker], opts(2));
    expect(p).not.toBeNull();
    sound(p!, 2);
    expect(p!.takerFill).toBe(15n * SH);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Brute force, sets: every combination of one usable order per other option. The largest common fill is found by
// stepping q down in half-share steps (every size here is a multiple of half a share), not by src's fixed point.

function bruteSet(taker: BookOrder, book: BookOrder[], n: number): { price: number; fill: bigint } | null {
  const per: BookOrder[][] = [];
  for (let opt = 0; opt < n; opt++) {
    if (opt === taker.option) continue;
    per.push(book.filter((o) => o.option === opt && o.isBuy === taker.isBuy && o.seq < taker.seq && o.maker !== taker.maker));
  }
  let best: { price: number; fill: bigint } | null = null;
  const pick: BookOrder[] = [];
  const walk = (i: number) => {
    if (i === per.length) {
      const sum = pick.reduce((s, o) => s + o.price, 0);
      if (sum > 100) return;
      const price = 100 - sum;
      if (taker.isBuy ? price > taker.price : price < taker.price) return;
      const parties = [taker, ...pick];
      let q = parties.reduce((m, o) => (o.remaining < m ? o.remaining : m), taker.remaining);
      while (q > 0n && !parties.every((o) => legalLeft(o.remaining, q))) q -= SH / 2n;
      if (q <= 0n) return;
      const better = best === null || (taker.isBuy ? price < best.price : price > best.price) || (price === best.price && q > best.fill);
      if (better) best = { price, fill: q };
      return;
    }
    for (const o of per[i]) {
      pick[i] = o;
      walk(i + 1);
    }
  };
  walk(0);
  return best;
}

describe('set fuzz against brute force', () => {
  const sizes = [10, 10.5, 11, 12, 15, 20, 25, 30].map((s) => BigInt(s * 2) * (SH / 2n));
  for (const [nOpt, perOpt, rounds] of [
    [3, 14, 400],
    [4, 6, 300],
  ] as const) {
    for (const isBuy of [true, false]) {
      it(`${nOpt} options, up to ${perOpt} orders per option, ${isBuy ? 'mint' : 'merge'}: same best price and fill`, () => {
        const r = rng(nOpt * 1000 + (isBuy ? 1 : 2));
        let found = 0;
        for (let round = 0; round < rounds; round++) {
          const book: BookOrder[] = [];
          let seq = 1;
          for (let opt = 1; opt < nOpt; opt++) {
            const k = 1 + Math.floor(r() * perOpt);
            // prices skewed high for mints (so the best bids often sum above 100) and low for merges
            for (let i = 0; i < k; i++) book.push(mk(seq++, seq, opt, isBuy, isBuy ? 20 + Math.floor(r() * 75) : 5 + Math.floor(r() * 40), sizes[Math.floor(r() * sizes.length)]));
          }
          const taker = mk(10_000, 1, 0, isBuy, isBuy ? 1 + Math.floor(r() * 99) : 1 + Math.floor(r() * 99), sizes[Math.floor(r() * sizes.length)]);
          const all = [...book, taker];
          const want = bruteSet(taker, all, nOpt);
          const got = proposeSet(taker, all, opts(nOpt));
          if (want === null) {
            expect(got, `round ${round}: brute force finds no set`).toBeNull();
            continue;
          }
          found++;
          expect(got, `round ${round}: brute force finds price ${want.price} fill ${want.fill}`).not.toBeNull();
          sound(got!, nOpt);
          expect([got!.takerPrice, got!.takerFill], `round ${round}`).toEqual([want.price, want.fill]);
        }
        expect(found).toBeGreaterThan(rounds / 10);
      });
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Brute force, direct: every assignment of skip / partial / whole to every candidate (books of at most 9), the
// partial amount spread analytically. Answers whether a legal direct fill exists and the largest taker fill.

function bruteDirect(taker: BookOrder, cands: BookOrder[]): bigint | null {
  const n = cands.length;
  let best: bigint | null = null;
  const st = new Array<number>(n).fill(0);
  const walk = (i: number) => {
    if (i === n) {
      let full = 0n;
      let lo = 0n;
      let hi = 0n;
      let count = 0;
      for (let j = 0; j < n; j++) {
        if (st[j] === 0) continue;
        count++;
        if (st[j] === 2) full += cands[j].remaining;
        else {
          const room = cands[j].remaining - MIN;
          if (room < LOT) return;
          lo += LOT;
          hi += room;
        }
      }
      if (count === 0 || count > 10) return;
      // largest S in [full + lo, full + hi] with S = T or T - S >= 10 shares
      const T = taker.remaining;
      let s = full + hi < T ? full + hi : T;
      if (s < T && T - s < MIN) s = T - MIN;
      if (s < full + lo || s <= 0n) return;
      if (best === null || s > best) best = s;
      return;
    }
    for (let v = 0; v < 3; v++) {
      st[i] = v;
      walk(i + 1);
    }
  };
  walk(0);
  return best;
}

describe('direct fuzz against brute force', () => {
  it('a legal direct fill exists exactly when proposeDirect finds one', () => {
    const r = rng(77);
    // Sizes near the 10-share minimum, where greedy fails most.
    const sizes = [10, 10.5, 11, 12, 13, 15, 19.5, 20, 21].map((s) => BigInt(s * 2) * (SH / 2n));
    let found = 0;
    let wholeOnly = 0;
    for (let round = 0; round < 600; round++) {
      const k = 1 + Math.floor(r() * 9);
      const asks: BookOrder[] = [];
      for (let i = 0; i < k; i++) asks.push(mk(i + 1, 10 + i, 0, false, 30 + Math.floor(r() * 20), sizes[Math.floor(r() * sizes.length)]));
      const taker = mk(100, 1, 0, true, 60, sizes[Math.floor(r() * sizes.length)]);
      const want = bruteDirect(taker, asks);
      const got = proposeDirect(taker, [...asks, taker], opts(2));
      if (want === null) {
        expect(got, `round ${round}`).toBeNull();
        continue;
      }
      found++;
      expect(got, `round ${round}: brute force fills ${want}`).not.toBeNull();
      sound(got!, 2);
      if (want === taker.remaining && got!.takerFill === taker.remaining) wholeOnly++;
    }
    expect(found).toBeGreaterThan(300);
    expect(wholeOnly).toBeGreaterThan(50);
  });
});

describe('work bound', () => {
  it('set: three options with 3,000 bids each, best bids summing above 100, distinct sizes', () => {
    const book: BookOrder[] = [];
    let seq = 1;
    for (let opt = 1; opt <= 2; opt++)
      for (let i = 0; i < 3000; i++) book.push(mk(seq++, seq, opt, true, 51 + (i % 49), 10n * SH + BigInt(i) * LOT * 7n));
    // the taker's size makes most q values legal, and its limit forces the subset-sum at every q
    const taker = mk(100_000, 1, 0, true, 1, 40n * SH);
    const t0 = performance.now();
    const p = proposeSet(taker, [...book, taker], opts(3));
    const ms = performance.now() - t0;
    if (p) sound(p, 3);
    expect(ms, `${ms.toFixed(0)} ms`).toBeLessThan(3000);
  });

  it('direct exact search: 5,000 asks of 10.5 shares for a 10-share taker', () => {
    const asks: BookOrder[] = [];
    for (let i = 0; i < 5000; i++) asks.push(mk(i + 1, 10 + i, 0, false, 50, 10n * SH + SH / 2n));
    const taker = mk(100_000, 1, 0, true, 60, 10n * SH);
    const t0 = performance.now();
    const p = proposeDirect(taker, [...asks, taker], opts(2));
    const ms = performance.now() - t0;
    // 0.5 share each from at most 10 makers is 5 shares: no whole fill exists, and the search must say so
    expect(p).toBeNull();
    expect(ms, `${ms.toFixed(0)} ms`).toBeLessThan(3000);
  });
});
