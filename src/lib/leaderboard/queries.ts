// ----------------------------------------------------------------------------
// #186 Leaderboard — read-side aggregation over the event ledger.
//
// Net PnL = SUM(claim) − SUM(bet) per actor. Verified against
// MakoMarketsV4.sol: `Claimed` fires ONLY for winners and refund
// claimants (losers revert NoPosition, double-claims revert
// AlreadyClaimed) and `_calcPayout` returns GROSS payout, so won−staked
// is true profit-after-fees. Refunds net ~0 once claimed; UNCLAIMED
// payouts (wins AND refunds) are invisible until claimed — documented
// UI caption, accepted v1 limitation.
//
// Creator fees are a separate role's income: own column, NEVER folded
// into bettor net. Creator seed bets DO count in staked — they're real
// positions (MakoMarketsV4.sol:433 emits a real BetPlaced).
//
// Precision discipline: amounts are numeric(78,0) in Postgres and
// travel as STRINGS end-to-end — never Number()'d (JS doubles corrupt
// 6dp sums at scale). Sorting happens IN SQL on the numeric expression,
// so string transport cannot mis-sort.
//
// Weekly window buckets each event by its own block_timestamp. Weekly
// NET is therefore cash-flow, not performance (a user claiming an old
// win shows stake-less profit). SHIPPED BEHAVIOR (Joshua's open-Q2
// call, option a): BOTH windows rank by NET; the weekly tab shows NET
// with an explanatory cash-flow caption in the UI. The
// orderBy: 'staked' branch below is RETAINED for the deferred
// volume-ranked alternative (option b) — production never passes it.
// ----------------------------------------------------------------------------

import { sql } from 'drizzle-orm';

import type { DbOrTx } from '@/db/client';
import { normalizeAddressLower } from '@/lib/private-markets/normalize';

export type LeaderboardWindow = 'all' | 'week';
export type LeaderboardOrderBy = 'net' | 'staked';

export interface LeaderboardRow {
  /// Lowercase on-chain address (ledger canonical form).
  actor: `0x${string}`;
  /// USDC base units (6dp), exact decimal strings.
  staked: string;
  won: string;
  /// won − staked; may be negative ("-5000000").
  net: string;
  bets: number;
  creatorFees: string;
}

export interface CallerRank {
  row: LeaderboardRow;
  /// 1-based position under the SAME total order the board renders
  /// (net DESC, actor ASC) — ties are broken by actor exactly like the
  /// board's ordinal numbering, so a pinned "YOUR RANK #N" can never
  /// contradict the board (review MINOR-2).
  rank: number;
}

// Both adapters expose row arrays; pglite wraps them in `{ rows }`.
function unwrapRows(result: unknown): Record<string, unknown>[] {
  const raw =
    (result as { rows?: unknown[] }).rows ?? (result as unknown[]);
  return raw as Record<string, unknown>[];
}

function toRow(r: Record<string, unknown>): LeaderboardRow {
  return {
    actor: String(r.actor) as `0x${string}`,
    staked: String(r.staked),
    won: String(r.won),
    net: String(r.net),
    bets: Number(r.bets),
    creatorFees: String(r.creatorFees),
  };
}

/// Window predicate as a composable SQL fragment. 'all' must still be
/// valid SQL, hence TRUE.
function windowPredicate(window: LeaderboardWindow) {
  return window === 'week'
    ? sql`block_timestamp >= now() - interval '7 days'`
    : sql`true`;
}

/// Shared per-actor aggregate CTE body. net is computed as a NUMERIC
/// expression (exact) and only cast to text at the outer select.
function aggregateCte(window: LeaderboardWindow) {
  return sql`
    SELECT
      actor,
      COALESCE(SUM(amount) FILTER (WHERE kind = 'bet'),   0) AS staked,
      COALESCE(SUM(amount) FILTER (WHERE kind = 'claim'), 0) AS won,
      COALESCE(SUM(amount) FILTER (WHERE kind = 'claim'), 0)
        - COALESCE(SUM(amount) FILTER (WHERE kind = 'bet'), 0) AS net,
      COUNT(*) FILTER (WHERE kind = 'bet')                   AS bets,
      COALESCE(SUM(amount) FILTER (WHERE kind = 'creator_fee'), 0)
                                                             AS creator_fees
    FROM mako_market_events
    WHERE ${windowPredicate(window)}
    GROUP BY actor
  `;
}

export interface GetLeaderboardRowsArgs {
  window: LeaderboardWindow;
  /// Defaults to 'net' — what production uses for BOTH windows.
  /// 'staked' (volume) is unused in production, retained for the
  /// deferred option-(b) weekly alternative.
  orderBy?: LeaderboardOrderBy;
  /// Board cap. Plan: top-100.
  limit?: number;
}

export async function getLeaderboardRows(
  db: DbOrTx,
  { window, orderBy = 'net', limit = 100 }: GetLeaderboardRowsArgs,
): Promise<LeaderboardRow[]> {
  if (!Number.isInteger(limit) || limit <= 0 || limit > 1000) {
    throw new RangeError(`getLeaderboardRows: bad limit ${limit}`);
  }
  // ORDER BY runs on the numeric aggregate (exact), with actor as a
  // deterministic tiebreak so pagination/snapshots are stable.
  //
  // The references MUST be table-qualified (agg.net, not net): the
  // outer SELECT aliases the ::text casts to the SAME names, and
  // Postgres resolves a bare identifier in ORDER BY against the OUTPUT
  // column first — which silently sorted the board LEXICOGRAPHICALLY
  // ("-4" after "-30"…). Found live on the smoke board (jester at
  // -0.30 ranked below -4.00); the original tests passed by
  // coincidence because their fixtures sorted identically both ways.
  const orderExpr =
    orderBy === 'staked' ? sql`agg.staked DESC` : sql`agg.net DESC`;
  const result = await db.execute(sql`
    WITH agg AS (${aggregateCte(window)})
    SELECT
      actor,
      staked::text        AS "staked",
      won::text           AS "won",
      net::text           AS "net",
      bets::int           AS "bets",
      creator_fees::text  AS "creatorFees"
    FROM agg
    ORDER BY ${orderExpr}, agg.actor ASC
    LIMIT ${limit}
  `);
  return unwrapRows(result).map(toRow);
}

export interface GetCallerRankArgs {
  window: LeaderboardWindow;
  /// Any casing — normalized to the ledger's lowercase form here.
  address: string;
}

/// Caller's own aggregate + 1-based rank by NET. Returns null when the
/// address has no events in the window. NOTE (plan, Codex r3 MINOR):
/// this re-runs the full per-actor aggregation uncached per request —
/// O(all actors). Testnet-fine; if it ever bites, derive rank from the
/// same cached aggregate the board uses (trading freshness).
export async function getCallerRank(
  db: DbOrTx,
  { window, address }: GetCallerRankArgs,
): Promise<CallerRank | null> {
  const addressLower = normalizeAddressLower(address);
  const result = await db.execute(sql`
    WITH agg AS (${aggregateCte(window)})
    SELECT
      a.actor,
      a.staked::text       AS "staked",
      a.won::text          AS "won",
      a.net::text          AS "net",
      a.bets::int          AS "bets",
      a.creator_fees::text AS "creatorFees",
      (SELECT COUNT(*) + 1 FROM agg b
        WHERE b.net > a.net
           OR (b.net = a.net AND b.actor < a.actor))::int AS "rank"
    FROM agg a
    WHERE a.actor = ${addressLower}
  `);
  const rows = unwrapRows(result);
  if (rows.length === 0) return null;
  return { row: toRow(rows[0]), rank: Number(rows[0].rank) };
}
