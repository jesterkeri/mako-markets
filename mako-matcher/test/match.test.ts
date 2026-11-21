import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import type { BookOrder } from '../src/book';
import { propose, proposeDirect, proposeSet, type MatchOpts, type Proposal } from '../src/match';
import { modelErrors, type MOrder } from './contract-model';
import { V, vec, toTuple } from './vectors';

const NOW_S = 1_999_900_000;
const SHARE = 1_000_000n;
let seq = 0;

function bo(p: Partial<BookOrder> & { maker: Hex; option: number; isBuy: boolean; price: number }): BookOrder {
  const size = p.size ?? 100n * SHARE;
  const filled = p.filled ?? 0n;
  seq += 1;
  return {
    seq: p.seq ?? seq,
    hash: (p.hash ?? (`0x${seq.toString(16).padStart(64, '0')}` as Hex)) as Hex,
    salt: 1n,
    marketId: p.marketId ?? 1n,
    expiration: p.expiration ?? 2_000_000_000n,
    nonce: 0n,
    signature: '0x11' as Hex,
    fee: 0n,
    createdAt: 0,
    size,
    filled,
    remaining: size - filled,
    ...p,
  } as BookOrder;
}

const W = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Hex;
const opts = (over: Partial<MatchOpts> = {}): MatchOpts => ({ nOptions: 3, nowSeconds: NOW_S, blocked: () => false, ...over });

/// A proposal judged by the contract model.
function judge(p: Proposal, nOptions = 3, refused: (a: Hex) => boolean = () => false) {
  const m = (o: BookOrder): MOrder => ({ maker: o.maker, marketId: o.marketId, option: o.option, isBuy: o.isBuy, price: o.price, size: o.size });
  return modelErrors(m(p.taker), p.makers.map(m), p.fills, p.takerFill, nOptions, refused);
}

function fromVec(name: string, over: Partial<BookOrder> = {}): BookOrder {
  const v = vec(name);
  return bo({ ...v.order, hash: v.hash, signature: v.signature, ...over } as never);
}

describe('the contract model agrees with the real vectors', () => {
  it('judges every settling vector call as valid', () => {
    for (const c of V.calls.filter((x) => x.expect.result === 'settles')) {
      const taker = toTuple(V.orders[c.taker].fields);
      const makers = c.makers.map((m) => toTuple(V.orders[m].fields));
      const err = modelErrors(taker, makers, c.fills.map(BigInt), BigInt(c.takerFill), 3, () => false);
      expect(err, c.id).toBeNull();
    }
  });
  it('reproduces the expected error of every step-5 negative vector', () => {
    const negs = (V as unknown as { negatives: { id: string; taker: string; makers: string[]; fills: string[]; takerFill: string; expect: { error?: string } }[] }).negatives;
    const step5 = new Set(['FillMismatch', 'SetPriceSum', 'BadOrderField', 'MarketMismatch', 'LengthMismatch']);
    let judged = 0;
    for (const n of negs) {
      const want = n.expect.error;
      if (!want || !step5.has(want) || n.id === 'makerSigsShort' || n.id === 'fillsLong') continue;
      const taker = toTuple(V.orders[n.taker].fields);
      const makers = n.makers.map((m) => toTuple(V.orders[m].fields));
      const got = modelErrors(taker, makers, n.fills.map(BigInt), BigInt(n.takerFill), 3, () => false);
      expect(got, n.id).toBe(want);
      judged++;
    }
    expect(judged).toBeGreaterThanOrEqual(8);
  });
});

describe('direct matches (plan 3.2 kind 1)', () => {
  it('three makers by price then time against the 300-share taker of the vectors', () => {
    const makers = ['direct3Maker3Sell', 'direct3Maker1Sell', 'direct3Maker2Sell'].map((n) => fromVec(n));
    const taker = fromVec('direct3TakerBuy', { seq: 10_000 });
    const p = propose(taker, [taker, ...makers], opts())!;
    expect(p.kind).toBe('direct');
    expect(p.makers.map((m) => m.price)).toEqual([50, 55, 58]);
    expect(p.fills).toEqual([100n * SHARE, 100n * SHARE, 100n * SHARE]);
    expect(p.takerFill).toBe(300n * SHARE);
    expect(judge(p)).toBeNull();
  });

  it('price-time priority: equal prices fill the older order first, and a partial fill ends the list', () => {
    const taker = bo({ seq: 10_000, maker: W(1), option: 0, isBuy: true, price: 60, size: 150n * SHARE });
    const late = bo({ maker: W(2), option: 0, isBuy: false, price: 50, seq: 20 });
    const early = bo({ maker: W(3), option: 0, isBuy: false, price: 50, seq: 10 });
    const dearer = bo({ maker: W(4), option: 0, isBuy: false, price: 55, seq: 5 });
    const p = proposeDirect(taker, [late, dearer, early], opts())!;
    expect(p.makers.map((m) => m.maker)).toEqual([W(3), W(2)]);
    expect(p.fills).toEqual([100n * SHARE, 50n * SHARE]);
    expect(p.takerFill).toBe(150n * SHARE);
    expect(judge(p)).toBeNull();
  });

  it('a sell taker takes the highest bids first', () => {
    const taker = bo({ seq: 10_000, maker: W(1), option: 0, isBuy: false, price: 40 });
    const lo = bo({ maker: W(2), option: 0, isBuy: true, price: 45 });
    const hi = bo({ maker: W(3), option: 0, isBuy: true, price: 52 });
    const none = bo({ maker: W(4), option: 0, isBuy: true, price: 39 });
    const p = proposeDirect(taker, [lo, hi, none], opts())!;
    expect(p.makers.map((m) => m.price)).toEqual([52]);
    expect(p.takerFill).toBe(100n * SHARE);
    expect(judge(p)).toBeNull();
  });

  it('never proposes more than 10 makers', () => {
    const makers = Array.from({ length: 12 }, (_, i) => bo({ maker: W(10 + i), option: 0, isBuy: false, price: 50, size: 10n * SHARE }));
    const taker = bo({ seq: 10_000, maker: W(1), option: 0, isBuy: true, price: 60, size: 120n * SHARE });
    const p = proposeDirect(taker, makers, opts())!;
    expect(p.makers).toHaveLength(10);
    expect(p.takerFill).toBe(100n * SHARE);
    expect(p.fills.reduce((a, b) => a + b, 0n)).toBe(p.takerFill);
    expect(judge(p)).toBeNull();
  });

  it('skips the taker\'s own wallet (self-trade skipping) and uses the next maker', () => {
    const taker = bo({ seq: 10_000, maker: W(1), option: 0, isBuy: true, price: 60 });
    const own = bo({ maker: W(1), option: 0, isBuy: false, price: 40 });
    const other = bo({ maker: W(2), option: 0, isBuy: false, price: 55 });
    const p = proposeDirect(taker, [own, other], opts())!;
    expect(p.makers.map((m) => m.maker)).toEqual([W(2)]);
    expect(proposeDirect(taker, [own], opts())).toBeNull();
  });

  it('skips other options, the same side, uncrossed prices, empty and expired orders', () => {
    const taker = bo({ seq: 10_000, maker: W(1), option: 0, isBuy: true, price: 50 });
    const book = [
      bo({ maker: W(2), option: 1, isBuy: false, price: 10 }),
      bo({ maker: W(3), option: 0, isBuy: true, price: 10 }),
      bo({ maker: W(4), option: 0, isBuy: false, price: 51 }),
      bo({ maker: W(5), option: 0, isBuy: false, price: 40, filled: 100n * SHARE }),
      bo({ maker: W(6), option: 0, isBuy: false, price: 40, expiration: BigInt(NOW_S) }),
    ];
    expect(proposeDirect(taker, book, opts())).toBeNull();
  });
});

describe('the later order is the taker (price-time priority)', () => {
  it('a resting ask at 40 and a newer bid at 60 trade at 40, whichever order is tried first', () => {
    const ask = bo({ maker: W(1), option: 0, isBuy: false, price: 40, seq: 1 });
    const bid = bo({ maker: W(2), option: 0, isBuy: true, price: 60, seq: 2 });
    const asTaker = propose(bid, [ask, bid], opts())!;
    expect(asTaker.taker).toBe(bid);
    expect(asTaker.makers).toEqual([ask]);
    // the older order is never the taker of a newer one: it would give the newcomer's price to the resting order
    expect(propose(ask, [ask, bid], opts())).toBeNull();
  });
  it('a set match also uses only older makers', () => {
    const taker = bo({ maker: W(1), option: 0, isBuy: true, price: 60, seq: 5 });
    const older = bo({ maker: W(2), option: 1, isBuy: true, price: 30, seq: 1 });
    const newer = bo({ maker: W(3), option: 2, isBuy: true, price: 30, seq: 9 });
    expect(proposeSet(taker, [older, newer], opts())).toBeNull();
    expect(proposeSet(taker, [older, { ...newer, seq: 2 }], opts())).not.toBeNull();
  });
});

describe('set matches (plan 3.2 kinds 2 and 3)', () => {
  it('a mint from the vectors: N - 1 buys, one on each other option, every fill equals takerFill', () => {
    const taker = fromVec('mintTakerBuy0', { seq: 10_000 });
    const makers = [fromVec('mintMakerBuy1'), fromVec('mintMakerBuy2')];
    const p = propose(taker, [...makers], opts())!;
    expect(p.kind).toBe('mint');
    expect(p.takerPrice).toBe(40);
    expect(p.fills).toEqual([100n * SHARE, 100n * SHARE]);
    expect(p.takerFill).toBe(100n * SHARE);
    expect(judge(p)).toBeNull();
  });

  it('a merge from the vectors', () => {
    const taker = fromVec('mergeTakerSell0', { seq: 10_000 });
    const p = propose(taker, [fromVec('mergeMakerSell1'), fromVec('mergeMakerSell2')], opts())!;
    expect(p.kind).toBe('merge');
    expect(p.takerPrice).toBe(35);
    expect(judge(p)).toBeNull();
  });

  it('maker prices summing to exactly 100 settle, the taker paying 0', () => {
    const p = propose(fromVec('sum100TakerBuy0', { seq: 10_000 }), [fromVec('sum100MakerBuy1'), fromVec('sum100MakerBuy2')], opts())!;
    expect(p.kind).toBe('mint');
    expect(p.takerPrice).toBe(0);
    expect(judge(p)).toBeNull();
  });

  it('NEVER proposes a mint or a merge whose maker prices sum above 100 (SetPriceSum)', () => {
    expect(propose(fromVec('sumMintTakerBuy0', { seq: 10_000 }), [fromVec('sumMintMakerBuy1'), fromVec('sumMintMakerBuy2')], opts())).toBeNull();
    expect(propose(fromVec('sumMergeTakerSell0', { seq: 10_000 }), [fromVec('sumMergeMakerSell1'), fromVec('sumMergeMakerSell2')], opts())).toBeNull();
    // 60 + 50 = 110 with a taker willing to pay anything, and with 101, 150, 198: still never
    const taker = bo({ seq: 10_000, maker: W(1), option: 0, isBuy: true, price: 99 });
    for (const [a, b] of [[60, 41], [75, 75], [99, 99]]) {
      const book = [bo({ maker: W(2), option: 1, isBuy: true, price: a }), bo({ maker: W(3), option: 2, isBuy: true, price: b })];
      expect(proposeSet(taker, book, opts()), `${a}+${b}`).toBeNull();
    }
    // 60 + 40 is exactly 100: fine
    expect(proposeSet(taker, [bo({ maker: W(2), option: 1, isBuy: true, price: 60 }), bo({ maker: W(3), option: 2, isBuy: true, price: 40 })], opts())).not.toBeNull();
  });

  it('does not mint when the taker\'s limit is below what it would pay, nor merge below its limit', () => {
    const mintTaker = bo({ seq: 10_000, maker: W(1), option: 0, isBuy: true, price: 39 });
    const buys = [bo({ maker: W(2), option: 1, isBuy: true, price: 30 }), bo({ maker: W(3), option: 2, isBuy: true, price: 30 })];
    expect(proposeSet(mintTaker, buys, opts())).toBeNull(); // would pay 40
    const mergeTaker = bo({ seq: 10_000, maker: W(1), option: 0, isBuy: false, price: 36 });
    const sells = [bo({ maker: W(2), option: 1, isBuy: false, price: 30 }), bo({ maker: W(3), option: 2, isBuy: false, price: 35 })];
    expect(proposeSet(mergeTaker, sells, opts())).toBeNull(); // would receive 35
  });

  it('needs a maker on EVERY other option, and uses the best (highest bid, then oldest) per option', () => {
    const taker = bo({ seq: 10_000, maker: W(1), option: 0, isBuy: true, price: 50 });
    expect(proposeSet(taker, [bo({ maker: W(2), option: 1, isBuy: true, price: 30 })], opts())).toBeNull();
    const book = [
      bo({ maker: W(2), option: 1, isBuy: true, price: 30, seq: 9 }),
      bo({ maker: W(3), option: 1, isBuy: true, price: 35, seq: 8 }),
      bo({ maker: W(4), option: 1, isBuy: true, price: 35, seq: 3 }),
      bo({ maker: W(5), option: 2, isBuy: true, price: 20 }),
    ];
    const p = proposeSet(taker, book, opts())!;
    expect(p.makers.map((m) => m.maker)).toEqual([W(4), W(5)]);
    expect(p.takerPrice).toBe(45);
  });

  it('fills the smallest remaining of the taker and every maker', () => {
    const taker = bo({ seq: 10_000, maker: W(1), option: 0, isBuy: true, price: 50, size: 100n * SHARE });
    const book = [bo({ maker: W(2), option: 1, isBuy: true, price: 30, size: 40n * SHARE }), bo({ maker: W(3), option: 2, isBuy: true, price: 30 })];
    const p = proposeSet(taker, book, opts())!;
    expect(p.takerFill).toBe(40n * SHARE);
    expect(p.fills).toEqual([40n * SHARE, 40n * SHARE]);
    expect(judge(p)).toBeNull();
  });

  it('works for a two-option market (one maker) and refuses a market too wide for 10 makers', () => {
    const taker = bo({ seq: 10_000, maker: W(1), option: 0, isBuy: true, price: 60 });
    const p = proposeSet(taker, [bo({ maker: W(2), option: 1, isBuy: true, price: 40 })], opts({ nOptions: 2 }))!;
    expect(p.kind).toBe('mint');
    expect(judge(p, 2)).toBeNull();
    expect(proposeSet(taker, [], opts({ nOptions: 12 }))).toBeNull();
    // 11 options means 10 makers: allowed (each pays 5, so the taker pays 50)
    const book = Array.from({ length: 10 }, (_, i) => bo({ maker: W(10 + i), option: i + 1, isBuy: true, price: 5 }));
    const wide = proposeSet(bo({ seq: 10_000, maker: W(1), option: 0, isBuy: true, price: 60 }), book, opts({ nOptions: 11 }))!;
    expect(wide.makers).toHaveLength(10);
    expect(judge(wide, 11)).toBeNull();
  });

  it('picks the better of a direct and a set match for the taker, and the direct one on a tie', () => {
    const taker = bo({ seq: 10_000, maker: W(1), option: 0, isBuy: true, price: 60 });
    const buys = [bo({ maker: W(2), option: 1, isBuy: true, price: 30 }), bo({ maker: W(3), option: 2, isBuy: true, price: 30 })]; // mint at 40
    const dearAsk = bo({ maker: W(4), option: 0, isBuy: false, price: 45 });
    expect(propose(taker, [...buys, dearAsk], opts())!.kind).toBe('mint');
    const cheapAsk = bo({ maker: W(4), option: 0, isBuy: false, price: 35 });
    expect(propose(taker, [...buys, cheapAsk], opts())!.kind).toBe('direct');
    const tieAsk = bo({ maker: W(4), option: 0, isBuy: false, price: 40 });
    expect(propose(taker, [...buys, tieAsk], opts())!.kind).toBe('direct');
  });
});

describe('what the matcher never proposes', () => {
  it('a match mixing markets', () => {
    const taker = bo({ seq: 10_000, maker: W(1), option: 0, isBuy: true, price: 60 });
    const other = bo({ maker: W(2), option: 0, isBuy: false, price: 10, marketId: 2n });
    expect(propose(taker, [other], opts())).toBeNull();
    // a set whose one leg is another market's
    const legs = [bo({ maker: W(2), option: 1, isBuy: true, price: 30 }), bo({ maker: W(3), option: 2, isBuy: true, price: 30, marketId: 2n })];
    expect(proposeSet(taker, legs, opts())).toBeNull();
    // with a same-market maker available the other market's order is still not used
    const same = bo({ maker: W(4), option: 0, isBuy: false, price: 55 });
    const p = propose(taker, [other, same], opts())!;
    expect(p.makers).toEqual([same]);
  });

  it('a party in the contract\'s refused roles, as maker or as taker', () => {
    const taker = bo({ seq: 10_000, maker: W(1), option: 0, isBuy: true, price: 60 });
    const refusedMaker = bo({ maker: W(9), option: 0, isBuy: false, price: 10 });
    const ok = bo({ maker: W(2), option: 0, isBuy: false, price: 55 });
    const o = opts({ blocked: (m) => m === W(9) });
    expect(propose(taker, [refusedMaker, ok], o)!.makers).toEqual([ok]);
    expect(propose(taker, [refusedMaker], o)).toBeNull();
    expect(propose(bo({ seq: 10_000, maker: W(9), option: 0, isBuy: true, price: 60 }), [ok], o)).toBeNull();
    // a refused wallet on one leg of a set
    const legs = [bo({ maker: W(2), option: 1, isBuy: true, price: 30 }), bo({ maker: W(9), option: 2, isBuy: true, price: 30 })];
    expect(proposeSet(taker, legs, o)).toBeNull();
  });

  it('an expired or exhausted taker', () => {
    const maker = bo({ maker: W(2), option: 0, isBuy: false, price: 50 });
    expect(propose(bo({ seq: 10_000, maker: W(1), option: 0, isBuy: true, price: 60, expiration: BigInt(NOW_S) }), [maker], opts())).toBeNull();
    expect(propose(bo({ seq: 10_000, maker: W(1), option: 0, isBuy: true, price: 60, filled: 100n * SHARE }), [maker], opts())).toBeNull();
  });
});

describe('fuzz: every proposal passes the contract model, on random books', () => {
  // A small seeded generator (mulberry32), so a failure reproduces.
  function rng(seed: number) {
    return () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('2,000 random books of 2 to 4 options, with blocked, expired and mixed-market orders', () => {
    let proposals = 0;
    const kinds = { direct: 0, mint: 0, merge: 0 };
    for (let seed = 1; seed <= 2000; seed++) {
      const r = rng(seed);
      const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
      const nOptions = int(2, 4);
      const wallets = Array.from({ length: 6 }, (_, i) => W(100 + i));
      const blockedSet = new Set(wallets.filter(() => r() < 0.15));
      seq = 0;
      const book: BookOrder[] = Array.from({ length: int(1, 16) }, () => {
        const size = BigInt(int(10, 120)) * SHARE;
        return bo({
          maker: wallets[int(0, wallets.length - 1)],
          option: int(0, nOptions - 1),
          isBuy: r() < 0.5,
          price: int(1, 99) % 100 === 0 ? 50 : int(1, 99),
          size,
          filled: r() < 0.2 ? (size / 2n / 10_000n) * 10_000n : 0n,
          marketId: r() < 0.1 ? 2n : 1n,
          expiration: r() < 0.1 ? BigInt(NOW_S - 5) : 2_000_000_000n,
        });
      });
      const o = opts({ nOptions, blocked: (m) => blockedSet.has(m) });
      const isRefused = (a: Hex) => blockedSet.has(a);
      for (const taker of book) {
        if (taker.marketId !== 1n) continue;
        const p = propose(taker, book, o);
        const live = taker.expiration > BigInt(NOW_S) && taker.remaining > 0n && !blockedSet.has(taker.maker);
        if (!p) {
          if (live) {
            // if any direct counterparty exists, a proposal must exist
            const any = book.some(
              (m) =>
                m.hash !== taker.hash && m.seq < taker.seq && m.marketId === 1n && m.option === taker.option && m.isBuy !== taker.isBuy && m.remaining > 0n && m.expiration > BigInt(NOW_S) &&
                m.maker !== taker.maker && !blockedSet.has(m.maker) && (taker.isBuy ? m.price <= taker.price : m.price >= taker.price),
            );
            expect(any, `seed ${seed}: a direct counterparty exists but nothing was proposed`).toBe(false);
          }
          continue;
        }
        proposals++;
        kinds[p.kind]++;
        // the contract refuses nothing about it
        expect(judge(p, nOptions, isRefused), `seed ${seed} ${p.kind}`).toBeNull();
        // and the matcher's own promises
        expect(p.makers.length).toBeLessThanOrEqual(10);
        expect(p.makers.every((m) => m.marketId === taker.marketId)).toBe(true);
        expect(p.makers.every((m) => m.maker !== taker.maker && !blockedSet.has(m.maker))).toBe(true);
        expect(p.makers.every((m, i) => m.remaining >= p.fills[i] && m.expiration > BigInt(NOW_S))).toBe(true);
        expect(p.takerFill).toBeLessThanOrEqual(taker.remaining);
        expect(new Set(p.makers.map((m) => m.hash)).size).toBe(p.makers.length);
        if (p.kind !== 'direct') expect(p.makers.reduce((a, m) => a + m.price, 0)).toBeLessThanOrEqual(100);
      }
    }
    // the run must actually have exercised all three kinds
    expect(proposals).toBeGreaterThan(1000);
    expect(kinds.direct).toBeGreaterThan(100);
    expect(kinds.mint).toBeGreaterThan(5);
    expect(kinds.merge).toBeGreaterThan(5);
  });
});
