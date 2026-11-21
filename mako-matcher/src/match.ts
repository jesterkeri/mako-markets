// Matching (plan 5, 3.2). Price-time priority, self-trade skipping, and proposals for the three match kinds with
// the per-kind fill rule. A pure function of the book: no clock, no chain, no storage.
//
// The matcher NEVER proposes (each is a test, and the contract would refuse each):
//   - a mint or merge whose maker prices sum above 100 (SetPriceSum);
//   - a match mixing markets (MarketMismatch);
//   - a party in the contract's refused roles (PartyRefused, plan 3.4), which the caller passes in as `blocked`;
//   - more than 10 makers (BadMakerCount);
//   - a maker who is the taker's own wallet (SelfMatch);
//   - a maker that arrived after the taker (the later order of a crossing pair is the taker).
import type { Hex } from 'viem';
import type { BookOrder } from './book';
import { MAX_MAKERS } from './config';

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

export function proposeDirect(taker: BookOrder, book: BookOrder[], opts: MatchOpts): Proposal | null {
  const cands = book
    .filter((o) => usable(o, taker, opts) && o.option === taker.option && o.isBuy !== taker.isBuy && (taker.isBuy ? o.price <= taker.price : o.price >= taker.price))
    // A buy taker takes the lowest asks first; a sell taker takes the highest bids first.
    .sort(byPriceTime(!taker.isBuy));
  const makers: BookOrder[] = [];
  const fills: bigint[] = [];
  let left = taker.remaining;
  for (const m of cands) {
    if (left === 0n || makers.length === MAX_MAKERS) break;
    const f = minBig(m.remaining, left);
    makers.push(m);
    fills.push(f);
    left -= f;
  }
  if (makers.length === 0) return null;
  const takerFill = taker.remaining - left;
  // Direct: the fills sum to takerFill, each maker filling its own part (plan 3.2).
  return { kind: 'direct', marketId: taker.marketId, taker, makers, fills, takerFill, takerPrice: makers[0].price };
}

/// Mint (taker buys) or merge (taker sells): one maker on each other option, all on the taker's side of the
/// ledger (buys for a mint, sells for a merge). The best maker per option; if the prices do not work the match is
/// not proposed (a different combination is not searched for).
export function proposeSet(taker: BookOrder, book: BookOrder[], opts: MatchOpts): Proposal | null {
  const need = opts.nOptions - 1;
  if (need < 1 || need > MAX_MAKERS) return null;
  const makers: BookOrder[] = [];
  for (let opt = 0; opt < opts.nOptions; opt++) {
    if (opt === taker.option) continue;
    const best = book
      .filter((o) => usable(o, taker, opts) && o.option === opt && o.isBuy === taker.isBuy)
      .sort(byPriceTime(taker.isBuy))[0];
    if (!best) return null;
    makers.push(best);
  }
  let sum = 0;
  for (const m of makers) sum += m.price;
  // SetPriceSum: never propose a set whose maker prices sum above 100.
  if (sum > 100) return null;
  const takerPrice = 100 - sum;
  // Mint: the taker pays 100 - sum and must not pay above its limit. Merge: it receives 100 - sum, at least its limit.
  if (taker.isBuy ? takerPrice > taker.price : takerPrice < taker.price) return null;
  // Mint and merge: every maker fills exactly the taker's fill (plan 3.2, [r9]).
  let takerFill = taker.remaining;
  for (const m of makers) takerFill = minBig(takerFill, m.remaining);
  if (takerFill <= 0n) return null;
  return { kind: taker.isBuy ? 'mint' : 'merge', marketId: taker.marketId, taker, makers, fills: makers.map(() => takerFill), takerFill, takerPrice };
}

/// The better of the direct and the set proposal for the taker (a lower price for a buy, a higher one for a sell);
/// a tie goes to the direct match.
export function propose(taker: BookOrder, book: BookOrder[], opts: MatchOpts): Proposal | null {
  if (taker.remaining <= 0n || taker.expiration <= BigInt(opts.nowSeconds) || opts.blocked(taker.maker)) return null;
  const d = proposeDirect(taker, book, opts);
  const s = proposeSet(taker, book, opts);
  if (d && s) return (taker.isBuy ? s.takerPrice < d.takerPrice : s.takerPrice > d.takerPrice) ? s : d;
  return d ?? s;
}
