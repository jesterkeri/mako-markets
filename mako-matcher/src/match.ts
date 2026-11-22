// Matching (plan 5, 3.2). Price-time priority, self-trade skipping, and proposals for the three match kinds with
// the per-kind fill rule. A pure function of the book: no clock, no chain, no storage.
//
// The matcher NEVER proposes (each is a test, and the contract would refuse each):
//   - a mint or merge whose maker prices sum above 100 (SetPriceSum);
//   - a match mixing markets (MarketMismatch);
//   - a party in the contract's refused roles (PartyRefused, plan 3.4), which the caller passes in as `blocked`;
//   - more than 10 makers (BadMakerCount);
//   - a maker who is the taker's own wallet (SelfMatch);
//   - a maker that arrived after the taker (the later order of a crossing pair is the taker);
//   - a fill that leaves any party (taker or maker) with 1 to 9 shares (plan 2 table, "no fill leaves 1 to 9 shares",
//     an operator book rule). A remainder already under 10 shares can only fill whole.
import type { Hex } from 'viem';
import type { BookOrder } from './book';
import { LOT, MAX_MAKERS, MIN_RESTING_SIZE } from './config';

export type MatchKind = 'direct' | 'mint' | 'merge';

export interface Proposal {
  kind: MatchKind;
  marketId: bigint;
  taker: BookOrder;
  makers: BookOrder[];
  /// fills[i] belongs to makers[i] and to no other index (plan 4.4).
  fills: bigint[];
  takerFill: bigint;
  /// What the taker pays (mint) or receives (merge) per share in cents, or the best maker price for a direct
  /// match. Used to choose between a direct and a set proposal; never signed.
  takerPrice: number;
}

export interface MatchOpts {
  /// The market's option count, read from the contract.
  nOptions: number;
  /// Unix seconds; an expired order is never a counterparty.
  nowSeconds: number;
  /// True for a wallet the matcher must not put in a match: the contract's refused roles, and an account refused
  /// for the UTC day.
  blocked: (maker: Hex) => boolean;
}

function usable(o: BookOrder, taker: BookOrder, opts: MatchOpts): boolean {
  return (
    o.hash !== taker.hash &&
    // price-time priority: only an order that was already resting when the taker arrived is a maker, so the trade
    // is at the resting order's price, never at the newcomer's
    o.seq < taker.seq &&
    o.marketId === taker.marketId &&
    o.remaining > 0n &&
    o.expiration > BigInt(opts.nowSeconds) &&
    o.maker !== taker.maker &&
    !opts.blocked(o.maker)
  );
}

/// Best price first, then earliest. `desc` is for buys (highest bid first).
function byPriceTime(desc: boolean) {
  return (a: BookOrder, b: BookOrder) => (a.price !== b.price ? (desc ? b.price - a.price : a.price - b.price) : a.seq - b.seq);
}

function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/// The largest fill of at most `cap` on an order with `remaining` left that leaves it 0 or at least 10 shares;
/// 0n when there is none. All three amounts are lot multiples, so the answer is too.
export function maxFill(remaining: bigint, cap: bigint): bigint {
  if (cap >= remaining) return remaining;
  const f = minBig(cap, remaining - MIN_RESTING_SIZE);
  return f > 0n ? f : 0n;
}

/// `bound`, when given, is the worst maker price the taker may trade at (the set price, so a direct match never
/// fills a level worse than the set).
export function proposeDirect(taker: BookOrder, book: BookOrder[], opts: MatchOpts, bound?: number): Proposal | null {
  const limit = bound === undefined ? taker.price : taker.isBuy ? Math.min(taker.price, bound) : Math.max(taker.price, bound);
  const cands = book
    .filter((o) => usable(o, taker, opts) && o.option === taker.option && o.isBuy !== taker.isBuy && (taker.isBuy ? o.price <= limit : o.price >= limit))
    // A buy taker takes the lowest asks first; a sell taker takes the highest bids first.
    .sort(byPriceTime(!taker.isBuy));
  // Fill the whole taker if the levels allow it; otherwise leave it at least 10 shares.
  const whole = fillLevels(cands, taker.remaining);
  const takerFill = whole.fills.reduce((a, b) => a + b, 0n);
  const left = taker.remaining - takerFill;
  let r = left === 0n || left >= MIN_RESTING_SIZE ? whole : fillLevels(cands, taker.remaining - MIN_RESTING_SIZE);
  // Greedy found nothing legal (an earlier maker used the budget so someone is left with 1 to 9 shares): search.
  if (r.makers.length === 0) r = searchFill(cands.slice(0, SEARCH_WINDOW), taker.remaining) ?? r;
  if (r.makers.length === 0) return null;
  // Direct: the fills sum to takerFill, each maker filling its own part (plan 3.2).
  return { kind: 'direct', marketId: taker.marketId, taker, makers: r.makers, fills: r.fills, takerFill: r.fills.reduce((a, b) => a + b, 0n), takerPrice: r.makers[0].price };
}

const SEARCH_WINDOW = MAX_MAKERS;

/// Fallback when greedy has no legal fill. Over the first 10 candidates (MAX_MAKERS, price-time order) tries each maker as
/// skipped, partial (1 lot to remaining - 10 shares) or full (all it has): at most 3^10 = 59049 cases, each O(10).
/// Picks the largest taker fill that leaves the taker 0 or >= 10 shares, then the lexicographically largest fills in
/// price-time order (earlier makers keep priority).
function searchFill(cands: BookOrder[], takerRem: bigint): { makers: BookOrder[]; fills: bigint[] } | null {
  const n = cands.length;
  const room = cands.map((m) => m.remaining - MIN_RESTING_SIZE); // top of the partial range; <= 0 means full only
  let best: bigint[] | null = null;
  let bestSum = 0n;
  const st = new Array<number>(n).fill(0); // 0 skip, 1 partial, 2 full
  const tryCase = () => {
    let full = 0n;
    let cap = 0n;
    let np = 0n;
    let count = 0;
    for (let i = 0; i < n; i++) {
      if (st[i] === 0) continue;
      count++;
      if (st[i] === 2) full += cands[i].remaining;
      else {
        if (room[i] <= 0n) return;
        cap += room[i];
        np += LOT;
      }
    }
    if (count === 0 || count > MAX_MAKERS) return;
    // total fill S in [full + np, full + cap], with S = takerRem or takerRem - S >= 10 shares
    let s = minBig(takerRem, full + cap);
    if (s < takerRem && takerRem - s < MIN_RESTING_SIZE) s = takerRem - MIN_RESTING_SIZE;
    if (s < full + np || s <= 0n || s < bestSum) return;
    let extra = s - full - np;
    const fills = cands.map((_, i) => {
      if (st[i] === 0) return 0n;
      if (st[i] === 2) return cands[i].remaining;
      const add = minBig(extra, room[i] - LOT);
      extra -= add;
      return LOT + add;
    });
    if (best === null || s > bestSum || lexGreater(fills, best)) {
      best = fills;
      bestSum = s;
    }
  };
  const walk = (i: number) => {
    if (i === n) return tryCase();
    for (let v = 0; v < 3; v++) {
      st[i] = v;
      walk(i + 1);
    }
  };
  walk(0);
  if (best === null) return null;
  const idx = (best as bigint[]).map((f, i) => (f > 0n ? i : -1)).filter((i) => i >= 0);
  return { makers: idx.map((i) => cands[i]), fills: idx.map((i) => (best as bigint[])[i]) };
}

function lexGreater(a: bigint[], b: bigint[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/// Greedy price-time fill of up to `budget`. A maker that cannot take a fill leaving it 0 or at least 10 shares is
/// passed over for this proposal (it keeps its place for the next).
function fillLevels(cands: BookOrder[], budget: bigint): { makers: BookOrder[]; fills: bigint[] } {
  const makers: BookOrder[] = [];
  const fills: bigint[] = [];
  let left = budget;
  for (const m of cands) {
    if (left <= 0n || makers.length === MAX_MAKERS) break;
    const f = maxFill(m.remaining, left);
    if (f === 0n) continue;
    makers.push(m);
    fills.push(f);
    left -= f;
  }
  return { makers, fills };
}

/// Mint (taker buys) or merge (taker sells): one maker on each other option, all on the taker's side of the
/// ledger (buys for a mint, sells for a merge). Combinations of the first 4 makers per option (price-time order) are
/// tried best-first, so when the best maker per option already works it is the answer. Work: at most 1024 legal-checked
/// combinations, each O(need).
export function proposeSet(taker: BookOrder, book: BookOrder[], opts: MatchOpts): Proposal | null {
  const need = opts.nOptions - 1;
  if (need < 1 || need > MAX_MAKERS) return null;
  const perOpt: BookOrder[][] = [];
  for (let opt = 0; opt < opts.nOptions; opt++) {
    if (opt === taker.option) continue;
    const c = book
      .filter((o) => usable(o, taker, opts) && o.option === opt && o.isBuy === taker.isBuy)
      .sort(byPriceTime(taker.isBuy))
      .slice(0, 4);
    if (c.length === 0) return null;
    perOpt.push(c);
  }
  let budget = 1024;
  const pick: BookOrder[] = [];
  const walk = (i: number): Proposal | null => {
    if (i === perOpt.length) return budget-- > 0 ? setProposal(taker, pick) : null;
    for (const m of perOpt[i]) {
      pick[i] = m;
      const r = walk(i + 1);
      if (r || budget <= 0) return r;
    }
    return null;
  };
  return walk(0);
}

function setProposal(taker: BookOrder, makers: BookOrder[]): Proposal | null {
  let sum = 0;
  for (const m of makers) sum += m.price;
  // SetPriceSum: never propose a set whose maker prices sum above 100.
  if (sum > 100) return null;
  const takerPrice = 100 - sum;
  // Mint: the taker pays 100 - sum and must not pay above its limit. Merge: it receives 100 - sum, at least its limit.
  if (taker.isBuy ? takerPrice > taker.price : takerPrice < taker.price) return null;
  // Mint and merge: every maker fills exactly the taker's fill (plan 3.2, [r9]). The largest fill that leaves every
  // party 0 or at least 10 shares; it only ever shrinks, so the loop ends.
  const parties = [taker, ...makers];
  let takerFill = parties.reduce((f, o) => minBig(f, o.remaining), taker.remaining);
  for (;;) {
    const next = parties.reduce((f, o) => minBig(f, maxFill(o.remaining, f)), takerFill);
    if (next === takerFill) break;
    takerFill = next;
  }
  if (takerFill <= 0n) return null;
  return { kind: taker.isBuy ? 'mint' : 'merge', marketId: taker.marketId, taker, makers: [...makers], fills: makers.map(() => takerFill), takerFill, takerPrice };
}

/// The better of the direct and the set proposal for the taker (a lower price for a buy, a higher one for a sell);
/// a tie goes to the direct match. Price priority holds at every level: a direct proposal takes only the levels at
/// least as good as the set price, and what is left of the taker is proposed again in the next pass.
export function propose(taker: BookOrder, book: BookOrder[], opts: MatchOpts): Proposal | null {
  if (taker.remaining <= 0n || taker.expiration <= BigInt(opts.nowSeconds) || opts.blocked(taker.maker)) return null;
  const s = proposeSet(taker, book, opts);
  return proposeDirect(taker, book, opts, s?.takerPrice) ?? s;
}
