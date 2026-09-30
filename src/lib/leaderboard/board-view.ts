// Leaderboard (12a): the pure data-to-view logic. Turns the /api/leaderboard payload into what the page draws:
// ranks, names, the podium and bar split, the viewer's pinned row and the "more to pass the next player" line.
// Browser-safe: no server imports, so the page and its tests share it.
//
// Amounts arrive as exact USDC base-unit strings (6 decimals) and stay bigint here; nothing goes through Number()
// except a bar's height fraction, which is bounded to 0..1.

import { formatAddress } from '@/lib/user-display';

// ---------------------------------------------------------------------------------------------------------------
// Wire (mirrors the GET /api/leaderboard response; the route imports server-only code, so it cannot be imported)

/// 'week' = the last 7 days, 'month' = the last 30 days, both rolling.
export type BoardPeriod = 'week' | 'month' | 'all';
export type BoardSort = 'profit' | 'volume';
export type BoardScope = 'all' | 'rounds' | 'pools';

export interface BoardWireRow {
  /// Lowercase address.
  actor: `0x${string}`;
  /// USDC base units as exact decimal strings.
  staked: string;
  won: string;
  /// won minus staked; may be negative.
  net: string;
  bets: number;
  creatorFees: string;
  displayName: string | null;
}

export interface BoardWireViewer extends BoardWireRow {
  rank: number;
}

export interface BoardWire {
  window: BoardPeriod;
  sort: BoardSort;
  rows: BoardWireRow[];
  /// Absent: the caller is on the board (or no caller). null: no activity in the period. Object: off the board.
  viewer?: BoardWireViewer | null;
  indexedThrough: number | null;
  /// True while past bets are still being indexed: the board is incomplete.
  syncing: boolean;
  generatedAt: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Freshness

/// The indexer runs every 30 minutes (about 6,000 blocks at Monad's 0.3-second blocks). Further behind the chain
/// than about three missed runs, the board is missing recent bets even when the indexer reports its last run as
/// complete (a stalled indexer never sets a new target).
export const INDEX_BEHIND_BLOCKS = 20_000n;

/// True when the ledger's last indexed block is more than INDEX_BEHIND_BLOCKS behind the chain head. Unknown
/// either side is not "behind": the API's own `syncing` covers a ledger with no cursor.
export function indexBehind(indexedThrough: number | null, head: bigint | undefined): boolean {
  if (indexedThrough === null || head === undefined) return false;
  return head - BigInt(indexedThrough) > INDEX_BEHIND_BLOCKS;
}

// ---------------------------------------------------------------------------------------------------------------
// Controls

export const PERIODS: readonly { key: BoardPeriod; label: string }[] = [
  { key: 'week', label: 'Last 7 days' },
  { key: 'month', label: 'Last 30 days' },
  { key: 'all', label: 'All time' },
];
export const DEFAULT_PERIOD: BoardPeriod = 'week';

/// Only pools are in the ledger, and "All markets" is every market the ledger holds, so both show the same board.
/// Rounds are not indexed yet: that scope is shown but cannot be picked.
export const SCOPES: readonly { key: BoardScope; label: string; comingSoon?: true }[] = [
  { key: 'all', label: 'All markets' },
  { key: 'rounds', label: 'Rounds', comingSoon: true },
  { key: 'pools', label: 'Pools' },
];

/// No win-rate sort: the ledger records bets and claims, not results, so a win rate cannot be computed.
export const SORTS: readonly { key: BoardSort; label: string; metric: string }[] = [
  { key: 'profit', label: 'Profit', metric: 'PROFIT' },
  { key: 'volume', label: 'Volume', metric: 'VOLUME' },
];
export const NEXT_SORT: Record<BoardSort, BoardSort> = { profit: 'volume', volume: 'profit' };

// ---------------------------------------------------------------------------------------------------------------
// Numbers

const UNIT = 1_000_000n; // base units per USDC
const CENT = 10_000n; // base units per cent

function group(n: bigint): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function centsText(cents: bigint): string {
  return `${group(cents / 100n)}.${(cents % 100n).toString().padStart(2, '0')}`;
}

/// "1,234.57": the absolute amount, rounded half up to the cent.
export function usdc2(units: bigint): string {
  const abs = units < 0n ? -units : units;
  return centsText((abs + CENT / 2n) / CENT);
}

export type Tone = 'up' | 'down' | 'flat';

/// Profit with its sign: "+15.00", "−5.00" (a minus sign, not a hyphen), "0.00".
export function signedUsdc2(units: bigint): { text: string; tone: Tone } {
  if (units > 0n) return { text: `+${usdc2(units)}`, tone: 'up' };
  if (units < 0n) return { text: `−${usdc2(units)}`, tone: 'down' };
  return { text: '0.00', tone: 'flat' };
}

/// The short label under a mobile bar: whole USDC from 100 up, cents below, so a 0.30 win never reads "+0".
function shortAbs(units: bigint): string {
  const abs = units < 0n ? -units : units;
  return abs >= 100n * UNIT ? group((abs + UNIT / 2n) / UNIT) : usdc2(abs);
}

export function shortMetric(row: Pick<BoardWireRow, 'net' | 'staked'>, sort: BoardSort): string {
  if (sort === 'volume') return shortAbs(BigInt(row.staked));
  const net = BigInt(row.net);
  if (net > 0n) return `+${shortAbs(net)}`;
  if (net < 0n) return `−${shortAbs(net)}`;
  return '0.00';
}

/// The value a sort ranks by, exact.
export function sortKey(row: Pick<BoardWireRow, 'net' | 'staked'>, sort: BoardSort): bigint {
  return sort === 'volume' ? BigInt(row.staked) : BigInt(row.net);
}

// ---------------------------------------------------------------------------------------------------------------
// Players

/// How each player is named: their display name, else their short address. Display names are not unique, so a name
/// used by more than one player gets a short address after it.
export function playerNames(rows: readonly BoardWireRow[], viewer?: BoardWireRow | null): Map<string, string> {
  const all = viewer && !rows.some((r) => r.actor === viewer.actor) ? [...rows, viewer] : [...rows];
  const clean = (r: BoardWireRow) => r.displayName?.trim() || null;
  const counts = new Map<string, number>();
  for (const r of all) {
    const n = clean(r);
    if (n) counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  const names = new Map<string, string>();
  for (const r of all) {
    const n = clean(r);
    names.set(r.actor, !n ? formatAddress(r.actor) : (counts.get(n) ?? 0) > 1 ? `${n} · ${formatAddress(r.actor)}` : n);
  }
  return names;
}

/// The letter in a player's avatar: their name's first letter, or the first hex digit of their address.
export function initialOf(displayName: string | null, actor: string): string {
  const name = displayName?.trim();
  if (name) return [...name][0]!.toUpperCase();
  const hex = actor.startsWith('0x') ? actor.slice(2) : actor;
  return (hex[0] ?? '?').toUpperCase();
}

/// Avatar colours, from the design's player palette. Signal yellow is left out: it marks "you".
export const AVATAR_COLOURS = [
  'var(--mako-teal)',
  'var(--mako-orange)',
  'var(--mako-violet)',
  'var(--mako-cyan)',
  'var(--mako-blue)',
  'var(--mako-fuchsia)',
  'var(--mako-gold)',
  'var(--mako-red)',
] as const;

/// A player's avatar colour, fixed by their address so it is the same on every visit.
export function avatarColour(actor: string): string {
  let h = 0;
  for (const ch of actor.toLowerCase()) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLOURS[h % AVATAR_COLOURS.length];
}

// ---------------------------------------------------------------------------------------------------------------
// The board

export interface PlayerView {
  actor: `0x${string}`;
  rank: number;
  name: string;
  initial: string;
  colour: string;
  profit: { text: string; tone: Tone };
  volume: string;
  bets: number;
  /// Earned a creator fee in the period (created a pool that paid one).
  creator: boolean;
  /// The sorted-by value in full ("+412.50" or "1,380.00").
  value: string;
  /// The sorted-by value, short, for the mobile bars.
  short: string;
}

export interface BoardView {
  /// Every row, ranked.
  players: PlayerView[];
  /// The desktop podium in its drawn order: #2, #1, #3. A missing place is null.
  podium: [PlayerView | null, PlayerView | null, PlayerView | null];
  /// The mobile bars: the top five, #1 first.
  bars: { player: PlayerView; heightPx: number; bg: string }[];
  /// Desktop list: #4 onwards (the podium holds the top three).
  restDesktop: PlayerView[];
  /// Mobile list: #6 onwards (the bars hold the top five).
  restMobile: PlayerView[];
  /// The signed-in player's pinned row, or null when signed out or not on the board in this period.
  me: { player: PlayerView; next: string | null } | null;
  syncing: boolean;
  empty: boolean;
}

/// The design's bar colours, by place.
export const BAR_COLOURS = [
  'var(--mako-signal)',
  'var(--mako-gold)',
  'var(--mako-orange)',
  'var(--mako-fuchsia)',
  'var(--mako-violet)',
] as const;

export const BAR_MIN_PX = 120;
export const BAR_RANGE_PX = 128;

/// Bar heights, as in the design: 120px plus up to 128px in proportion to the largest value. A zero or negative
/// value (a loss, when sorted by profit) gets the minimum; it never grows a bar.
export function barHeights(values: readonly bigint[]): number[] {
  const max = values.reduce((m, v) => (v > m ? v : m), 0n);
  return values.map((v) => {
    if (max <= 0n || v <= 0n) return BAR_MIN_PX;
    const permille = Number((v * 1000n) / max);
    return BAR_MIN_PX + Math.round((permille / 1000) * BAR_RANGE_PX);
  });
}

/// The smallest amount (base units) that moves `me` above `ahead` under the board's order (value high to low, then
/// address low to high), or null when `me` is not actually behind `ahead` (the board and the live rank can come
/// from moments up to a minute apart).
export function gapToPass(me: { key: bigint; actor: string }, ahead: { key: bigint; actor: string }): bigint | null {
  const behind = ahead.key > me.key || (ahead.key === me.key && ahead.actor < me.actor);
  if (!behind) return null;
  // Drawing level is enough only when the address tie-break already favours me.
  return me.actor < ahead.actor ? ahead.key - me.key : ahead.key - me.key + 1n;
}

/// "+12.93 USDC more to pass the next player": the gap rounded UP to the cent, so the amount shown is always enough.
export function nextLine(gap: bigint, sort: BoardSort): string {
  const amount = centsText((gap + CENT - 1n) / CENT);
  return sort === 'volume' ? `+${amount} USDC more volume to pass the next player` : `+${amount} USDC more to pass the next player`;
}

function toPlayer(row: BoardWireRow, rank: number, sort: BoardSort, names: Map<string, string>): PlayerView {
  const profit = signedUsdc2(BigInt(row.net));
  const volume = usdc2(BigInt(row.staked));
  return {
    actor: row.actor,
    rank,
    name: names.get(row.actor) ?? formatAddress(row.actor),
    initial: initialOf(row.displayName, row.actor),
    colour: avatarColour(row.actor),
    profit,
    volume,
    bets: row.bets,
    creator: BigInt(row.creatorFees) > 0n,
    value: sort === 'volume' ? volume : profit.text,
    short: shortMetric(row, sort),
  };
}

/// Everything the page draws, from one API payload. `account` is the signed-in account's address (any casing).
export function buildBoardView(wire: BoardWire, account: string | null): BoardView {
  const sort = wire.sort;
  const viewer = wire.viewer ?? null;
  const names = playerNames(wire.rows, viewer);
  const players = wire.rows.map((r, i) => toPlayer(r, i + 1, sort, names));

  const top5 = players.slice(0, 5);
  const heights = barHeights(wire.rows.slice(0, 5).map((r) => sortKey(r, sort)));

  const meLower = account?.toLowerCase() ?? null;
  let me: BoardView['me'] = null;
  if (meLower) {
    const i = wire.rows.findIndex((r) => r.actor === meLower);
    let mine: BoardWireRow | null = null;
    let ahead: BoardWireRow | null = null;
    let player: PlayerView | null = null;
    if (i >= 0) {
      mine = wire.rows[i];
      ahead = i > 0 ? wire.rows[i - 1] : null;
      player = players[i];
    } else if (viewer && viewer.actor === meLower) {
      mine = viewer;
      // The player just ahead is known only when it is the board's last row.
      ahead = viewer.rank === wire.rows.length + 1 && wire.rows.length > 0 ? wire.rows[wire.rows.length - 1] : null;
      player = toPlayer(viewer, viewer.rank, sort, names);
    }
    if (mine && player) {
      const gap = ahead ? gapToPass({ key: sortKey(mine, sort), actor: mine.actor }, { key: sortKey(ahead, sort), actor: ahead.actor }) : null;
      me = { player, next: gap === null ? null : nextLine(gap, sort) };
    }
  }

  return {
    players,
    podium: [players[1] ?? null, players[0] ?? null, players[2] ?? null],
    bars: top5.map((player, k) => ({ player, heightPx: heights[k], bg: BAR_COLOURS[k] })),
    restDesktop: players.slice(3),
    restMobile: players.slice(5),
    me,
    syncing: wire.syncing,
    empty: players.length === 0,
  };
}

/// "1 bet", "12 bets".
export function betsText(n: number): string {
  return `${n} ${n === 1 ? 'bet' : 'bets'}`;
}
