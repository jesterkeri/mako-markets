// The Pools list (8a): which pools show, in which group and order, and what each row says. Pure, so the grouping,
// the states and the payout figures are tested without a chain.

import { computeResolvedClaim } from './bet';
import { formatCountdown } from './countdown';
import { MarketType, Outcome, type MarketWithId } from './contract';
import { noMultiplier, yesMultiplier } from './mocks';

export type PoolCat = 'CRYPTO' | 'FOOTBALL' | 'NBA' | 'FOREX' | 'COMMODITIES' | 'STOCKS' | 'MAKO';
export type PoolFilter = 'ALL' | PoolCat;
export type PoolSort = 'closing' | 'pool' | 'bettors';

/// The filter pills, in the design's order. MAKO house pools are not in the design; they must not disappear, so
/// they take the last pill.
export const POOL_FILTERS: readonly PoolFilter[] = ['ALL', 'CRYPTO', 'FOOTBALL', 'NBA', 'FOREX', 'COMMODITIES', 'STOCKS', 'MAKO'];

const CAT_OF: Record<MarketType, PoolCat> = {
  [MarketType.FOOTBALL]: 'FOOTBALL',
  [MarketType.CRYPTO]: 'CRYPTO',
  [MarketType.BASKETBALL]: 'NBA',
  [MarketType.FOREX]: 'FOREX',
  [MarketType.COMMODITIES]: 'COMMODITIES',
  [MarketType.STOCKS]: 'STOCKS',
  [MarketType.MAKO]: 'MAKO',
};

/// Badge colour, badge text colour and abbreviation per category, from the design's CAT table. MAKO takes coral,
/// which no other category or state uses.
export const CAT_STYLE: Record<PoolCat, { bg: string; fg: string; abbr: string }> = {
  CRYPTO: { bg: 'var(--mako-red)', fg: '#000', abbr: 'CR' },
  FOOTBALL: { bg: 'var(--mako-signal)', fg: '#000', abbr: 'FB' },
  NBA: { bg: 'var(--mako-orange)', fg: 'var(--mako-paper)', abbr: 'NBA' },
  FOREX: { bg: 'var(--mako-teal)', fg: 'var(--mako-ink)', abbr: 'FX' },
  COMMODITIES: { bg: 'var(--mako-gold)', fg: 'var(--mako-ink)', abbr: 'CM' },
  STOCKS: { bg: 'var(--mako-blue)', fg: 'var(--mako-paper)', abbr: 'ST' },
  MAKO: { bg: 'var(--mako-coral)', fg: '#000', abbr: 'MK' },
};

/// "CRYPTO" -> "Crypto", "NBA" and "MAKO" as they are.
export function catTitle(c: PoolFilter): string {
  if (c === 'ALL') return 'All';
  if (c === 'NBA') return 'NBA';
  if (c === 'MAKO') return 'Mako';
  return c[0] + c.slice(1).toLowerCase();
}

/// What a filtered list says when the category has no open pool: "No crypto pools open right now."
export function noOpenPoolsTitle(filter: PoolFilter): string {
  return `No ${filter === 'NBA' ? 'NBA' : filter === 'MAKO' ? 'Mako' : filter.toLowerCase()} pools open right now.`;
}

/// Where a pool is in its life. The pill colours follow 9a (and 18a for resolving).
export type PoolState = 'open' | 'betting_closed' | 'resolving' | 'yes_won' | 'no_won' | 'refunded';

export const STATE_PILL: Record<Exclude<PoolState, 'open'>, { label: string; bg: string }> = {
  betting_closed: { label: 'Betting closed', bg: 'var(--mako-gold)' },
  resolving: { label: 'Resolving', bg: 'var(--mako-violet)' },
  yes_won: { label: 'YES won', bg: 'var(--mako-teal)' },
  no_won: { label: 'NO won', bg: 'var(--mako-red)' },
  refunded: { label: 'Refunded', bg: 'var(--mako-cyan)' },
};

/// The pool page's state colour and words, open included (yellow, "Open"); the share card uses the same.
export const STATE_COLOUR: Record<PoolState, string> = {
  open: 'var(--mako-signal)',
  betting_closed: STATE_PILL.betting_closed.bg,
  resolving: STATE_PILL.resolving.bg,
  yes_won: STATE_PILL.yes_won.bg,
  no_won: STATE_PILL.no_won.bg,
  refunded: STATE_PILL.refunded.bg,
};
export const stateLabel = (s: PoolState) => (s === 'open' ? 'Open' : STATE_PILL[s].label);

export function poolState(m: MarketWithId, nowSec: number): PoolState {
  if (m.resolved) {
    if (m.outcome === Outcome.YES) return 'yes_won';
    if (m.outcome === Outcome.NO) return 'no_won';
    return 'refunded';
  }
  if (nowSec < Number(m.bettingCloseTime)) return 'open';
  if (nowSec < Number(m.closeTime)) return 'betting_closed';
  return 'resolving';
}

/// The signed-in account's stake in one pool, from `getUserBet`.
export type UserBet = { yes: bigint; no: bigint; claimed: boolean };

/// What the account holds in a pool, as the row reports it.
export type Position =
  | { kind: 'staked'; yes: bigint; no: bigint }
  | { kind: 'won'; amount: bigint; claimed: boolean }
  | { kind: 'lost'; amount: bigint }
  | { kind: 'refund'; amount: bigint; claimed: boolean };

export function positionOf(m: MarketWithId, state: PoolState, bet: UserBet | undefined): Position | null {
  if (!bet || (bet.yes === 0n && bet.no === 0n)) return null;
  if (state === 'refunded') return { kind: 'refund', amount: bet.yes + bet.no, claimed: bet.claimed };
  if (state === 'yes_won' || state === 'no_won') {
    const yesWon = state === 'yes_won';
    const stake = yesWon ? bet.yes : bet.no;
    if (stake === 0n) return { kind: 'lost', amount: yesWon ? bet.no : bet.yes };
    const winnerPool = yesWon ? m.totalYes : m.totalNo;
    const loserPool = yesWon ? m.totalNo : m.totalYes;
    const amount = computeResolvedClaim(winnerPool, loserPool, stake, BigInt(m.protocolFeeBpsSnapshot), BigInt(m.creatorFeeBpsSnapshot));
    return { kind: 'won', amount, claimed: bet.claimed };
  }
  return { kind: 'staked', yes: bet.yes, no: bet.no };
}

/// What an unclaimed position can claim now, or null.
export function claimable(p: Position | null): bigint | null {
  if (!p || (p.kind !== 'won' && p.kind !== 'refund') || p.claimed || p.amount === 0n) return null;
  return p.amount;
}

/// USDC base units -> "1,240.50".
/// An amount someone confirms (a bet, a first bet, a claim), exactly: at least 2 decimals, up to all 6, never
/// rounded. "2.00", "1.999999", "1,250.50".
export function usdcExact(base: bigint): string {
  const sign = base < 0n ? '-' : '';
  const v = base < 0n ? -base : base;
  const frac = (v % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${sign}${(v / 1_000_000n).toLocaleString('en-US')}.${frac}`;
}

/// USDC base units at two decimals, rounded half up, in integer arithmetic: pool totals are uint256, so going through
/// Number would drop cents above 2^53 base units (Codex S3 r1).
/// Whole USDC, rounded down, grouped: exact at any size (the Pools summary's "USDC in play").
export function wholeUsdc(base: bigint): string {
  return ((base < 0n ? 0n : base) / 1_000_000n).toLocaleString('en-US');
}

export function usdc2(base: bigint): string {
  const neg = base < 0n;
  const cents = ((neg ? -base : base) + 5_000n) / 10_000n;
  const text = `${(cents / 100n).toLocaleString('en-US')}.${(cents % 100n).toString().padStart(2, '0')}`;
  return neg && cents > 0n ? `-${text}` : text;
}

/// The row's position chip: "You · YES 5.00", "You · Won 9.40", "You · Lost 5.00", "You · Refund 5.00".
export function positionLabel(p: Position): string {
  switch (p.kind) {
    case 'staked': {
      const sides = [p.yes > 0n ? `YES ${usdc2(p.yes)}` : '', p.no > 0n ? `NO ${usdc2(p.no)}` : ''].filter(Boolean);
      return `You · ${sides.join(' · ')}`;
    }
    case 'won':
      return `You · Won ${usdc2(p.amount)}`;
    case 'lost':
      return `You · Lost ${usdc2(p.amount)}`;
    case 'refund':
      return `You · Refund ${usdc2(p.amount)}`;
  }
}

/// How long ago, for a closed pool's CLOSES column: "Just now", "12M ago", "6H ago", "1D ago".
export function formatAgo(seconds: number): string {
  const s = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  if (s < 60) return 'Just now';
  if (s < 3_600) return `${Math.floor(s / 60)}M ago`;
  if (s < 86_400) return `${Math.floor(s / 3_600)}H ago`;
  return `${Math.floor(s / 86_400)}D ago`;
}

/// Pays per 1 USDC at the current pool, as the contract settles it. A side with no stake of its own cannot quote a
/// payout (null); a side facing an empty other side gets its stake back, so it pays 1.00.
function paysPerOne(sidePool: bigint, raw: number): number | null {
  if (sidePool === 0n) return null;
  return raw === 0 ? 1 : raw;
}

/// A side's pays-per-1-USDC figure as the lists print it: "1.82x", or "" when the side has no stake to quote from.
export function formatPays(n: number | null): string {
  return n === null ? '' : `${n.toFixed(2)}x`;
}

export type PoolRow = {
  id: bigint;
  cat: PoolCat;
  question: string;
  creator: `0x${string}`;
  /// Distinct bettors per side, summed, as the contract counts them (a wallet on both sides counts on each).
  bettors: number;
  pool: bigint;
  /// Whole percentages of the pool on each side (0 and 0 only for an empty pool, which the contract never makes).
  yesPct: number;
  noPct: number;
  yesPays: number | null;
  noPays: number | null;
  state: PoolState;
  /// Seconds until betting closes; negative once it has.
  secsLeft: number;
  /// The CLOSES column: a countdown while open, "Closed" while waiting for a result, "1D ago" once settled.
  closes: string;
  /// Under an hour left: the design turns the countdown red.
  closingSoon: boolean;
  position: Position | null;
};

export function poolRow(m: MarketWithId, nowSec: number, bet?: UserBet): PoolRow {
  const state = poolState(m, nowSec);
  const total = m.totalYes + m.totalNo;
  const yesPct = total === 0n ? 0 : Math.round(Number((m.totalYes * 10_000n) / total) / 100);
  const noPct = total === 0n ? 0 : 100 - yesPct;
  const secsLeft = Number(m.bettingCloseTime) - nowSec;
  const closes =
    state === 'open' ? formatCountdown(secsLeft) : state === 'betting_closed' || state === 'resolving' ? 'Closed' : formatAgo(-secsLeft);
  return {
    id: m.id,
    cat: CAT_OF[m.mType],
    question: m.question,
    creator: m.creator,
    bettors: m.yesBettorCount + m.noBettorCount,
    pool: total,
    yesPct,
    noPct,
    yesPays: paysPerOne(m.totalYes, yesMultiplier(m)),
    noPays: paysPerOne(m.totalNo, noMultiplier(m)),
    state,
    secsLeft,
    closes,
    closingSoon: state === 'open' && secsLeft < 3_600,
    position: positionOf(m, state, bet),
  };
}

/// Closed pools stay in the list for a week after betting closed; older ones live on Me.
export const CLOSED_WINDOW_SEC = 7 * 86_400;

export type PoolGroup = { title: 'Closing today' | 'Later this week' | 'Closed'; rows: PoolRow[] };

export type PoolList = {
  groups: PoolGroup[];
  /// Open pools per filter pill, and the header's totals over open pools.
  counts: Record<PoolFilter, number>;
  openCount: number;
  openTotal: bigint;
};

function byClosing(a: PoolRow, b: PoolRow) {
  return a.secsLeft - b.secsLeft || Number(a.id - b.id);
}
function byPool(a: PoolRow, b: PoolRow) {
  return a.pool === b.pool ? Number(a.id - b.id) : a.pool > b.pool ? -1 : 1;
}
function byBettors(a: PoolRow, b: PoolRow) {
  return b.bettors - a.bettors || Number(a.id - b.id);
}

/// The whole list: open pools in "Closing today" (under 24 hours left) and "Later this week", each in the chosen
/// order, then pools that closed in the last week, most recent first. Private Markets are a separate contract and
/// never appear here.
export function buildPoolList(
  markets: readonly MarketWithId[],
  nowSec: number,
  filter: PoolFilter,
  sort: PoolSort,
  bets?: ReadonlyMap<string, UserBet>,
): PoolList {
  // V4's MarketType enum has exactly the seven categories above, so `m.mType in CAT_OF` holds for every real pool.
  const rows = markets
    .filter((m) => m.mType in CAT_OF && nowSec - Number(m.bettingCloseTime) <= CLOSED_WINDOW_SEC)
    .map((m) => poolRow(m, nowSec, bets?.get(m.id.toString())));

  const open = rows.filter((r) => r.state === 'open');
  const counts = Object.fromEntries(POOL_FILTERS.map((f) => [f, f === 'ALL' ? open.length : open.filter((r) => r.cat === f).length])) as Record<
    PoolFilter,
    number
  >;
  const openTotal = open.reduce((sum, r) => sum + r.pool, 0n);

  const keep = (r: PoolRow) => filter === 'ALL' || r.cat === filter;
  const order = sort === 'pool' ? byPool : sort === 'bettors' ? byBettors : byClosing;
  const today = open.filter((r) => keep(r) && r.secsLeft < 86_400).sort(order);
  const later = open.filter((r) => keep(r) && r.secsLeft >= 86_400).sort(order);
  const closed = rows.filter((r) => r.state !== 'open' && keep(r)).sort((a, b) => b.secsLeft - a.secsLeft || Number(b.id - a.id));

  const groups = (
    [
      ['Closing today', today],
      ['Later this week', later],
      ['Closed', closed],
    ] as const
  )
    .filter(([, g]) => g.length > 0)
    .map(([title, g]) => ({ title, rows: g }));

  return { groups, counts, openCount: open.length, openTotal };
}

export type ClosingSoon = {
  /// At most `limit` open pools in the filter, the one whose betting closes first at the top.
  rows: PoolRow[];
  /// Open pools in every category: Home shows the pools empty state only when this is 0.
  openCount: number;
};

/// Home's pools (2a): the open pools that close soonest, in the same order and with the same rows as the Pools
/// list's "Closing soon" sort. Closed and settled pools never appear here. `bets` (the account's stakes) only fills
/// each row's position; it never changes which rows show.
export function closingSoon(
  markets: readonly MarketWithId[],
  nowSec: number,
  filter: PoolFilter,
  limit: number,
  bets?: ReadonlyMap<string, UserBet>,
): ClosingSoon {
  const open = markets
    .filter((m) => m.mType in CAT_OF && poolState(m, nowSec) === 'open')
    .map((m) => poolRow(m, nowSec, bets?.get(m.id.toString())));
  const rows = open
    .filter((r) => filter === 'ALL' || r.cat === filter)
    .sort(byClosing)
    .slice(0, Math.max(0, Math.floor(limit)));
  return { rows, openCount: open.length };
}
