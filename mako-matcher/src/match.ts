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
  // Greedy found nothing legal (an earlier maker used the budget so someone is left with 1 to 9 shares): search the
  // whole book exactly.
  if (r.makers.length === 0) r = exactFill(cands, taker.remaining) ?? r;
  if (r.makers.length === 0) return null;
  // Direct: the fills sum to takerFill, each maker filling its own part (plan 3.2).
  return { kind: 'direct', marketId: taker.marketId, taker, makers: r.makers, fills: r.fills, takerFill: r.fills.reduce((a, b) => a + b, 0n), takerPrice: r.makers[0].price };
}

/// Fallback when both greedy passes have no legal fill. Then every legal direct match fills the WHOLE taker, and the
/// taker is under 20 shares: the second pass (budget = taker - 10 shares) takes the first candidate that can give
/// anything, so it finds nothing only when no candidate can fill 10 shares short of the taker or less (the taker is at
/// most 10 shares, or every candidate fills whole only and has more than taker - 10 shares, while a whole-only order
/// has at most 10). Exact over all candidates (Codex MATCHER R2: a 10-candidate window starved legal fills): each
/// maker fills nothing, whole, or 1 lot to remaining - 10 shares; at most MAX_MAKERS makers; fills sum to the taker.
/// Picks the lexicographically largest fills in price-time order (earlier makers keep priority). Work: O(n x 11)
/// operations on bit sets of at most 2,000 bits (the taker in lots), and memory for (n + 1) x 11 of them.
function exactFill(cands: BookOrder[], takerRem: bigint): { makers: BookOrder[]; fills: bigint[] } | null {
  // Unreachable with candidates present (see above); guards the bit-set width.
  if (cands.length === 0 || takerRem >= 2n * MIN_RESTING_SIZE) return null;
  const T = Number(takerRem / LOT);
  const mask = (1n << BigInt(T + 1)) - 1n;
  const full = cands.map((m) => (m.remaining <= takerRem ? Number(m.remaining / LOT) : 0)); // 0: cannot fill whole
  const room = cands.map((m) => (m.remaining - MIN_RESTING_SIZE >= LOT ? Number((m.remaining - MIN_RESTING_SIZE) / LOT) : 0)); // partial up to
  // feas[j][k]: the sums (bit s = s lots) candidates j.. can make with at most k makers.
  const n = cands.length;
  const feas: bigint[][] = new Array(n + 1);
  feas[n] = new Array<bigint>(MAX_MAKERS + 1).fill(1n);
  for (let j = n - 1; j >= 0; j--) {
    const next = feas[j + 1];
    const row = new Array<bigint>(MAX_MAKERS + 1);
    row[0] = 1n;
    for (let k = 1; k <= MAX_MAKERS; k++) {
      let v = next[k];
      if (full[j] > 0) v |= next[k - 1] << BigInt(full[j]);
      if (room[j] > 0) v |= smear(next[k - 1] << 1n, Math.min(room[j], T) - 1);
      row[k] = v & mask;
    }
    feas[j] = row;
  }
  const has = (bits: bigint, i: number) => i >= 0 && ((bits >> BigInt(i)) & 1n) === 1n;
  if (!has(feas[0][MAX_MAKERS], T)) return null;
  const makers: BookOrder[] = [];
  const fills: bigint[] = [];
  let need = T;
  let k = MAX_MAKERS;
  for (let j = 0; j < n && need > 0; j++) {
    const rest = feas[j + 1][k - 1];
    let f = 0;
    if (full[j] > 0 && full[j] <= need && has(rest, need - full[j])) f = full[j];
    else if (room[j] > 0) {
      // the largest partial fill whose remainder the later candidates can make
      for (let x = Math.min(room[j], need); x >= 1; x--) {
        if (has(rest, need - x)) {
          f = x;
          break;
        }
      }
    }
    if (f === 0) continue; // skipping keeps it feasible: feas[j][k] had `need` and this maker adds nothing
    makers.push(cands[j]);
    fills.push(BigInt(f) * LOT);
    need -= f;
    k--;
  }
  return { makers, fills };
}

/// Every shift of `bits` by 0 to `len` places, OR-ed together.
function smear(bits: bigint, len: number): bigint {
  let acc = bits;
  let covered = 1; // acc holds the shifts 0 .. covered - 1
  while (covered * 2 <= len + 1) {
    acc |= acc << BigInt(covered);
    covered *= 2;
  }
  if (covered < len + 1) acc |= acc << BigInt(len + 1 - covered);
  return acc;
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

/// Mint (taker buys) or merge (taker sells): one maker on each other option, all on the taker's side of the ledger
/// (buys for a mint, sells for a merge), every party filling the same amount q. Exact over the whole book (Codex
/// MATCHER R2 F1: a fixed window of makers per option starved legal sets and let a worse direct price win):
///   - the largest q a set of orders can all fill (leaving each 0 or at least 10 shares) is one party's remaining or
///     remaining - 10 shares, so q is tried only at those values;
///   - at a given q an order is usable when q leaves it 0 or at least 10 shares; a price level's maker at q is its
///     EARLIEST usable order, and the options are independent: the best taker price is the best sum of one usable
///     price per option (prices are whole cents): for a merge the lowest; for a mint the highest within SetPriceSum's
///     100 cap, by a subset-sum over 0..100 when the best prices overshoot.
/// Ranking (Codex MATCHER R3 F1: price-time priority, never a larger fill ahead of an earlier order):
///   1. the best taker price (a lower one for a mint, a higher one for a merge);
///   2. time: the makers' arrival order compared option by option, in option order (the earlier maker on the first
///      option where two sets differ wins), so at the same price an earlier usable order is never passed over for a
///      later one because the later one allows a larger fill. There is no queue across options, so option order is the
///      stated convention for sets whose first difference is on different options;
///   3. the larger q.
/// Work: O(n log n) to index the book, then for each of at most 2n + 2 values of q, O(options x 99 x log n), plus the
/// subset-sum (options x 99 shifts of a 101-bit set) only when the best mint prices sum above 100.
export function proposeSet(taker: BookOrder, book: BookOrder[], opts: MatchOpts): Proposal | null {
  const need = opts.nOptions - 1;
  if (need < 1 || need > MAX_MAKERS) return null;
  const mint = taker.isBuy;
  const levels: Level[][] = [];
  const qs = new Set<bigint>([taker.remaining, taker.remaining - MIN_RESTING_SIZE]);
  for (let opt = 0; opt < opts.nOptions; opt++) {
    if (opt === taker.option) continue;
    const byPrice = new Map<number, BookOrder[]>();
    for (const o of book) {
      if (!usable(o, taker, opts) || o.option !== opt || o.isBuy !== taker.isBuy) continue;
      const l = byPrice.get(o.price);
      if (l) l.push(o);
      else byPrice.set(o.price, [o]);
      qs.add(o.remaining);
      qs.add(o.remaining - MIN_RESTING_SIZE);
    }
    if (byPrice.size === 0) return null;
    levels.push([...byPrice.entries()].sort((a, b) => a[0] - b[0]).map(([price, os]) => level(price, os)));
  }
  const T = taker.remaining;
  const qList = [...qs].filter((q) => q >= LOT && q <= T && (q === T || q <= T - MIN_RESTING_SIZE)).sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  // Mint: the taker pays 100 - sum, at most its limit. Merge: it receives 100 - sum, at least its limit.
  const lo = mint ? 100 - taker.price : need;
  const hi = mint ? 100 : 100 - taker.price;
  let best: { sum: number; makers: BookOrder[] } | null = null;
  for (const q of qList) {
    // Per option, the levels usable at q (ascending price) with each one's earliest usable order.
    const avail = levels.map((ls) => ls.map((l) => ({ price: l.price, o: earliestAt(l, q) })).filter((x): x is Pick => x.o !== null));
    if (avail.some((a) => a.length === 0)) continue;
    const picks = mint ? bestMint(avail) : avail.map((a) => a[0]);
    if (!picks) continue;
    const sum = picks.reduce((a, x) => a + x.price, 0);
    if (sum < lo || sum > hi) continue;
    const makers = picks.map((x) => x.o);
    // q descends, so a set equal on price and time keeps the larger q.
    if (best === null || (mint ? sum > best.sum : sum < best.sum) || (sum === best.sum && earlierSet(makers, best.makers))) best = { sum, makers };
  }
  return best === null ? null : setProposal(taker, best.makers);
}

/// One price level of one option: `exact` maps a remaining to the earliest order with it; `atLeast` lists, by
/// remaining descending, the earliest order among those with at least that remaining.
type Level = { price: number; exact: Map<bigint, BookOrder>; atLeast: { rem: bigint; o: BookOrder }[] };
type Pick = { price: number; o: BookOrder };

function level(price: number, os: BookOrder[]): Level {
  const exact = new Map<bigint, BookOrder>();
  for (const o of os) {
    const e = exact.get(o.remaining);
    if (!e || o.seq < e.seq) exact.set(o.remaining, o);
  }
  const atLeast: { rem: bigint; o: BookOrder }[] = [];
  for (const [rem, o] of [...exact.entries()].sort((a, b) => (a[0] > b[0] ? -1 : a[0] < b[0] ? 1 : 0))) {
    const prev = atLeast[atLeast.length - 1];
    atLeast.push({ rem, o: prev && prev.o.seq < o.seq ? prev.o : o });
  }
  return { price, exact, atLeast };
}

/// The level's earliest order that a fill of q leaves at 0 or at least 10 shares, or null.
function earliestAt(l: Level, q: bigint): BookOrder | null {
  const whole = l.exact.get(q) ?? null;
  const t = q + MIN_RESTING_SIZE;
  // last index with rem >= t (atLeast is descending by rem)
  let a = 0;
  let b = l.atLeast.length;
  while (a < b) {
    const m = (a + b) >>> 1;
    if (l.atLeast[m].rem >= t) a = m + 1;
    else b = m;
  }
  const part = a > 0 ? l.atLeast[a - 1].o : null;
  if (!whole) return part;
  if (!part) return whole;
  return whole.seq < part.seq ? whole : part;
}

/// True when set `a` is earlier than set `b`: the earlier maker on the first option where they differ.
function earlierSet(a: BookOrder[], b: BookOrder[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i].seq !== b[i].seq) return a[i].seq < b[i].seq;
  return false;
}

/// A mint's makers: one pick per option with the highest price sum at most 100, and among those sums' choices the
/// earliest set (option by option). The top prices when they fit (the only choice with that sum); otherwise a
/// subset-sum over sums 0..100 from the last option back (suf[i] = sums options i.. can make), then option by option
/// the earliest maker whose price keeps the rest reachable. Null when every choice is above 100.
function bestMint(avail: Pick[][]): Pick[] | null {
  const top = avail.map((a) => a[a.length - 1]);
  if (top.reduce((s, x) => s + x.price, 0) <= 100) return top;
  const n = avail.length;
  const suf: Uint32Array[] = new Array(n + 1);
  suf[n] = Uint32Array.of(1, 0, 0, 0);
  for (let i = n - 1; i >= 0; i--) {
    suf[i] = new Uint32Array(4);
    for (const x of avail[i]) shiftOr(suf[i], suf[i + 1], x.price);
  }
  const bit = (b: Uint32Array, s: number) => s >= 0 && s <= 100 && ((b[s >>> 5] >>> (s & 31)) & 1) === 1;
  let s = 100;
  while (s >= 0 && !bit(suf[0], s)) s--;
  if (s < 0) return null;
  const out: Pick[] = [];
  for (let i = 0; i < n; i++) {
    let pick: Pick | null = null;
    for (const x of avail[i]) if (bit(suf[i + 1], s - x.price) && (pick === null || x.o.seq < pick.o.seq)) pick = x;
    out.push(pick as Pick);
    s -= (pick as Pick).price;
  }
  return out;
}

/// dst |= src << p, on 128-bit sets held as four 32-bit words (bits past 127 drop; only sums up to 100 are read).
function shiftOr(dst: Uint32Array, src: Uint32Array, p: number): void {
  const w = p >>> 5;
  const b = p & 31;
  for (let i = 3; i >= w; i--) {
    let v = src[i - w] << b;
    if (b !== 0 && i - w - 1 >= 0) v |= src[i - w - 1] >>> (32 - b);
    dst[i] |= v >>> 0;
  }
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
