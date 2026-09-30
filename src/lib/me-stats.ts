// Me (11a): the account's totals, its positions and its profit series, from chain reads only (the Pools contract,
// V4). Pure, so the sums, the won / lost / refund split, the range filter and the chart are tested without a chain.
//
// Rules, all from the contract:
//  - IN PLAY is every stake in a pool that is not resolved yet (open, betting closed, or waiting for its result).
//  - READY TO CLAIM is what `claim()` would pay now: a win or a refund not yet claimed.
//  - WON ALL TIME is the payout of every winning position, claimed or not. A refund is not a win.
//  - A settled pool nets payout minus the whole stake (both sides, if the account held both). A refund nets 0.
//
// V4 stores no resolution time, so the profit series is ordered by each pool's close time (the earliest moment it
// could settle), and the chart says so.

import { computeResolvedClaim } from './bet';
import type { MarketWithId } from './contract';
import { dayTime, RESOLUTION_GRACE_SEC } from './pool-rules';
import { claimable, formatAgo, poolRow, usdc2, type PoolCat, type PoolState, type Position, type UserBet } from './pool-list';
import { formatCountdown } from './countdown';

const DAY = 86_400;

export type Settlement = {
  kind: 'won' | 'lost' | 'refund';
  /// What `claim()` pays for this position: the winnings, the stake back on a refund, 0 on a loss.
  payout: bigint;
  /// Payout minus the whole stake: 0 on a refund, minus the stake on a loss.
  net: bigint;
};

export type MePosition = {
  market: MarketWithId;
  cat: PoolCat;
  state: PoolState;
  bet: UserBet;
  /// Both sides together.
  stake: bigint;
  position: Position;
  /// What the account can claim now, or null.
  claim: bigint | null;
  /// Null until the pool is resolved.
  settlement: Settlement | null;
};

function settlementOf(position: Position, stake: bigint): Settlement | null {
  switch (position.kind) {
    case 'staked':
      return null;
    case 'refund':
      return { kind: 'refund', payout: position.amount, net: 0n };
    case 'lost':
      return { kind: 'lost', payout: 0n, net: -stake };
    case 'won':
      return { kind: 'won', payout: position.amount, net: position.amount - stake };
  }
}

/// Every pool the account has a stake in, with where it stands at `nowSec`. Pools with no stake are left out.
export function mePositions(markets: readonly MarketWithId[], bets: ReadonlyMap<string, UserBet>, nowSec: number): MePosition[] {
  const out: MePosition[] = [];
  for (const m of markets) {
    const bet = bets.get(m.id.toString());
    if (!bet) continue;
    const row = poolRow(m, nowSec, bet);
    if (!row.position) continue;
    const stake = bet.yes + bet.no;
    out.push({ market: m, cat: row.cat, state: row.state, bet, stake, position: row.position, claim: claimable(row.position), settlement: settlementOf(row.position, stake) });
  }
  return out;
}

export type MeStats = {
  inPlay: bigint;
  readyToClaim: bigint;
  wonAllTime: bigint;
  /// Not resolved yet, the next to settle first.
  active: MePosition[];
  /// Resolved, the most recent close first.
  settled: MePosition[];
  /// Settled positions with something to claim, in the same order.
  claims: MePosition[];
  /// A win or a refund was already claimed, so an empty claims list means "everything claimed".
  claimedBefore: boolean;
};

const byCloseAsc = (a: MePosition, b: MePosition) =>
  a.market.closeTime === b.market.closeTime ? Number(a.market.id - b.market.id) : a.market.closeTime < b.market.closeTime ? -1 : 1;

export function meStats(positions: readonly MePosition[]): MeStats {
  const active = positions.filter((p) => p.settlement === null).sort(byCloseAsc);
  const settled = positions.filter((p) => p.settlement !== null).sort((a, b) => byCloseAsc(b, a));
  const claims = settled.filter((p) => p.claim !== null);
  return {
    inPlay: active.reduce((s, p) => s + p.stake, 0n),
    readyToClaim: sumClaims(claims),
    wonAllTime: settled.reduce((s, p) => s + (p.settlement!.kind === 'won' ? p.settlement!.payout : 0n), 0n),
    active,
    settled,
    claims,
    claimedBefore: settled.some((p) => (p.position.kind === 'won' || p.position.kind === 'refund') && p.position.claimed),
  };
}

export function sumClaims(claims: readonly MePosition[]): bigint {
  return claims.reduce((s, p) => s + (p.claim ?? 0n), 0n);
}

/// Pools this account created, whatever their state (the contract stores the creator's address as given).
export function createdCount(markets: readonly MarketWithId[], account: string): number {
  const me = account.toLowerCase();
  return markets.filter((m) => m.creator.toLowerCase() === me).length;
}

// ---------------------------------------------------------------------------------------------------------------
// Profit

export type MeRange = '7d' | '30d' | 'all';

export const ME_RANGES: readonly { key: MeRange; label: string; long: string }[] = [
  { key: '7d', label: '7D', long: 'last 7 days' },
  { key: '30d', label: '30D', long: 'last 30 days' },
  { key: 'all', label: 'All', long: 'all time' },
];

const RANGE_SEC: Record<Exclude<MeRange, 'all'>, number> = { '7d': 7 * DAY, '30d': 30 * DAY };

export type ProfitSeries = {
  /// The running net after each settled pool, starting from 0 before the first.
  points: bigint[];
  total: bigint;
  pools: number;
  won: number;
  lost: number;
  refunded: number;
  /// The first pool's close time, or null with no settled pool in range.
  firstClose: number | null;
};

/// Cumulative net over the settled pools whose close time falls in the range (ending now), oldest close first.
export function profitSeries(positions: readonly MePosition[], nowSec: number, range: MeRange): ProfitSeries {
  const since = range === 'all' ? -Infinity : nowSec - RANGE_SEC[range];
  const rows = positions.filter((p) => p.settlement !== null && Number(p.market.closeTime) >= since).sort(byCloseAsc);
  const points = [0n];
  let run = 0n;
  let won = 0;
  let lost = 0;
  let refunded = 0;
  for (const p of rows) {
    const s = p.settlement!;
    run += s.net;
    points.push(run);
    if (s.kind === 'won') won++;
    else if (s.kind === 'lost') lost++;
    else refunded++;
  }
  return { points, total: run, pools: rows.length, won, lost, refunded, firstClose: rows.length ? Number(rows[0].market.closeTime) : null };
}

export type ChartGeometry = {
  /// SVG paths in a 600 x 140 box.
  line: string;
  area: string;
  zeroY: number;
  /// Where zero sits, 0 at the top to 1 at the bottom: the gradient turns from yellow to red there.
  zeroOffset: number;
  /// The last point's height as a percentage of the box, for the end dot.
  endYPct: number;
  endNegative: boolean;
};

const W = 600;
const H = 140;

/// The design's chart: evenly spaced points, 8px of headroom, zero always in view. A flat series sits mid-box.
export function chartGeometry(points: readonly bigint[]): ChartGeometry {
  const vals = (points.length >= 2 ? points : [0n, points[0] ?? 0n]).map((v) => Number(v) / 1e6);
  const lo = Math.min(0, ...vals);
  const hi = Math.max(0, ...vals);
  const y = (v: number) => (hi === lo ? H / 2 : 8 + ((hi - v) / (hi - lo)) * 124);
  const x = (i: number) => (i / (vals.length - 1)) * W;
  const line = vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const last = vals[vals.length - 1];
  return {
    line,
    area: `${line} L${W} ${H} L0 ${H} Z`,
    zeroY: y(0),
    zeroOffset: y(0) / H,
    endYPct: (y(last) / H) * 100,
    endNegative: last < 0,
  };
}

/// "+15.62", "−4.10" (a minus sign, as the design writes it), "0.00".
export function signedUsdc(v: bigint): string {
  if (v > 0n) return `+${usdc2(v)}`;
  if (v < 0n) return `−${usdc2(-v)}`;
  return '0.00';
}

// ---------------------------------------------------------------------------------------------------------------
// Rows

/// What each held side would pay if it wins, at the pool as it stands (the contract's claim maths).
export function estPayouts(m: MarketWithId, bet: UserBet): { side: 'yes' | 'no'; payout: bigint }[] {
  return (['yes', 'no'] as const)
    .filter((s) => (s === 'yes' ? bet.yes : bet.no) > 0n)
    .map((s) => {
      const win = s === 'yes' ? m.totalYes : m.totalNo;
      const lose = s === 'yes' ? m.totalNo : m.totalYes;
      const stake = s === 'yes' ? bet.yes : bet.no;
      return { side: s, payout: computeResolvedClaim(win, lose, stake, BigInt(m.protocolFeeBpsSnapshot), BigInt(m.creatorFeeBpsSnapshot)) };
    });
}

/// The row's time line: "Closes in 1D 2H", "Settles after Sat 18:30", "Waiting for the result", "Closed 1D ago".
export function positionMeta(p: MePosition, nowSec: number, timeZone?: string): string {
  const m = p.market;
  switch (p.state) {
    case 'open':
      return `Closes in ${formatCountdown(Number(m.bettingCloseTime) - nowSec)}`;
    case 'betting_closed':
      return `Settles after ${dayTime(Number(m.closeTime), timeZone)}`;
    case 'resolving':
      return nowSec >= Number(m.closeTime) + RESOLUTION_GRACE_SEC ? 'Not settled in 24H: it can be refunded' : 'Waiting for the result';
    default: {
      const ago = formatAgo(nowSec - Number(m.closeTime));
      return `Closed ${ago === 'Just now' ? 'just now' : ago}`;
    }
  }
}

/// A settled row's result: "Won 9.40", "Lost 5.00", "Refund 5.00".
export function resultLabel(s: Settlement, stake: bigint): string {
  if (s.kind === 'won') return `Won ${usdc2(s.payout)}`;
  if (s.kind === 'lost') return `Lost ${usdc2(stake)}`;
  return `Refund ${usdc2(s.payout)}`;
}
