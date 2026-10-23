import 'server-only';

// Standings of the $100 trading competition (REFERRAL_COMPETITION_PLAN r1, section 3). Three steps:
//   1. one SQL query: the entrants (registered accounts whose code has REQUIRED_REFERRALS qualifying referrals) and,
//      per entrant and counted pool, the YES and NO stakes and the claims inside the window;
//   2. one multicall of getMarket over those pools for the outcomes (a failed read is unsettled, never a loss);
//   3. names and photos from the leaderboard's identity rules (never an email or a user id).
//
// Counted pools: only pools whose first bet by that player falls inside [START, END). Bets and claims on a pool the
// player had bet on before START are left out entirely, so an old win claimed inside the window is not profit with
// no stake (the one deliberate change from the leaderboard's cash-flow math). Amounts stay exact: numeric in SQL,
// text on the wire, bigint here.

import { unstable_cache } from 'next/cache';
import { sql } from 'drizzle-orm';

import { db, type DbOrTx } from '@/db/client';
import { getAaPublicClient } from '@/lib/aa-public-client';
import { MONAD_TESTNET_ID } from '@/lib/chain';
import { MAKO_ADDRESS, makoAbi, Outcome } from '@/lib/contract';
import { resolveLabels } from '@/lib/leaderboard/identity';

import { COMPETITION_END, COMPETITION_START, MIN_SETTLED, REQUIRED_REFERRALS } from './config';
import { ACCOUNTS_CTE, CONTRACT_LOWER, QUALIFIED_CTE, unwrapRows } from './referrals';

/// One entrant's position on one counted pool; market is null for an entrant with no counted pool yet.
export interface PositionRow {
  actor: string;
  market: string | null;
  yes: bigint;
  no: bigint;
  claimed: bigint;
}

/// A pool's result at read time; null when the read failed.
export type PoolOutcome = { resolved: boolean; outcome: number } | null;

export interface EntrantScore {
  actor: string;
  net: bigint;
  won: number;
  settled: number;
}

export interface StandingRow {
  actor: `0x${string}`;
  displayName: string | null;
  avatarUrl: string | null;
  /// USDC base units, exact.
  net: string;
  won: number;
  settled: number;
}

export interface CompetitionStandings {
  ranked: StandingRow[];
  unranked: StandingRow[];
  generatedAt: string;
}

/// Step 1. Each entrant appears at least once (market null when nothing counts yet).
export async function readPositions(dbx: DbOrTx): Promise<PositionRow[]> {
  const start = COMPETITION_START.toISOString();
  const end = COMPETITION_END.toISOString();
  const rows = unwrapRows(
    await dbx.execute(sql`
      WITH ${ACCOUNTS_CTE}, ${QUALIFIED_CTE},
      eligible AS (SELECT code FROM qualified GROUP BY code HAVING count(*) >= ${REQUIRED_REFERRALS}),
      entrants AS (
        SELECT DISTINCT a.addr FROM accounts a JOIN eligible g ON g.code = 'r-' || substr(a.addr, 3, 30)
      ),
      counted AS (
        SELECT e.actor, e.market_id, e.kind, e.is_yes, e.amount
        FROM mako_market_events e
        JOIN entrants n ON n.addr = e.actor
        WHERE e.chain_id = ${MONAD_TESTNET_ID} AND e.contract_address = ${CONTRACT_LOWER}
          AND e.kind IN ('bet', 'claim')
          AND e.block_timestamp >= ${start}::timestamptz AND e.block_timestamp < ${end}::timestamptz
          AND NOT EXISTS (
            SELECT 1 FROM mako_market_events p
            WHERE p.chain_id = e.chain_id AND p.contract_address = e.contract_address
              AND p.market_id = e.market_id AND p.actor = e.actor
              AND p.kind = 'bet' AND p.block_timestamp < ${start}::timestamptz
          )
      )
      SELECT
        n.addr AS "actor",
        c.market_id AS "market",
        COALESCE(SUM(c.amount) FILTER (WHERE c.kind = 'bet' AND c.is_yes), 0)::text AS "yes",
        COALESCE(SUM(c.amount) FILTER (WHERE c.kind = 'bet' AND NOT c.is_yes), 0)::text AS "no",
        COALESCE(SUM(c.amount) FILTER (WHERE c.kind = 'claim'), 0)::text AS "claimed"
      FROM entrants n
      LEFT JOIN counted c ON c.actor = n.addr
      GROUP BY n.addr, c.market_id
      ORDER BY n.addr, c.market_id
    `),
  );
  return rows.map((r) => ({
    actor: String(r.actor),
    market: r.market === null || r.market === undefined ? null : String(r.market),
    yes: BigInt(String(r.yes)),
    no: BigInt(String(r.no)),
    claimed: BigInt(String(r.claimed)),
  }));
}

/// Per entrant: net = claims minus stakes over counted pools; a pool is settled when resolved YES or NO (REFUND,
/// unresolved and failed reads are not), and won when the stake on the winning side beats the losing side.
export function foldPositions(rows: readonly PositionRow[], outcomes: ReadonlyMap<string, PoolOutcome>): Map<string, EntrantScore> {
  const out = new Map<string, EntrantScore>();
  for (const r of rows) {
    const s = out.get(r.actor) ?? { actor: r.actor, net: 0n, won: 0, settled: 0 };
    out.set(r.actor, s);
    if (r.market === null) continue;
    s.net += r.claimed - r.yes - r.no;
    const o = outcomes.get(r.market);
    if (!o?.resolved || (o.outcome !== Outcome.YES && o.outcome !== Outcome.NO)) continue;
    s.settled += 1;
    const [win, lose] = o.outcome === Outcome.YES ? [r.yes, r.no] : [r.no, r.yes];
    if (win > lose) s.won += 1;
  }
  return out;
}

/// Ranked: settled >= minSettled, by net DESC, then win rate DESC (exact cross-multiplication), then settled DESC,
/// then actor ASC. The rest are listed unranked, most settled first.
export function rankEntrants(scores: Iterable<EntrantScore>, minSettled: number): { ranked: EntrantScore[]; unranked: EntrantScore[] } {
  const all = [...scores];
  const byActor = (a: EntrantScore, b: EntrantScore) => (a.actor < b.actor ? -1 : a.actor > b.actor ? 1 : 0);
  const ranked = all
    .filter((s) => s.settled >= minSettled)
    .sort((a, b) => {
      if (a.net !== b.net) return a.net > b.net ? -1 : 1;
      const rate = b.won * a.settled - a.won * b.settled;
      if (rate !== 0) return rate;
      if (a.settled !== b.settled) return b.settled - a.settled;
      return byActor(a, b);
    });
  const unranked = all.filter((s) => s.settled < minSettled).sort((a, b) => b.settled - a.settled || byActor(a, b));
  return { ranked, unranked };
}

/// Step 2. Throws when the whole read fails (the page shows its error line; nothing is cached).
async function readOutcomes(markets: readonly string[]): Promise<Map<string, PoolOutcome>> {
  if (markets.length === 0) return new Map();
  const results = await getAaPublicClient(MONAD_TESTNET_ID).multicall({
    contracts: markets.map((id) => ({ address: MAKO_ADDRESS, abi: makoAbi, functionName: 'getMarket' as const, args: [BigInt(id)] as const })),
    allowFailure: true,
  });
  return new Map(
    results.map((r, i) => {
      const m = r.status === 'success' ? (r.result as { resolved: boolean; outcome: number }) : null;
      return [markets[i], m ? { resolved: m.resolved, outcome: Number(m.outcome) } : null];
    }),
  );
}

export async function readCompetitionStandings(dbx: DbOrTx): Promise<CompetitionStandings> {
  const rows = await readPositions(dbx);
  const markets = [...new Set(rows.flatMap((r) => (r.market === null ? [] : [r.market])))];
  const outcomes = await readOutcomes(markets);
  const { ranked, unranked } = rankEntrants(foldPositions(rows, outcomes).values(), MIN_SETTLED);
  const labels = await resolveLabels(dbx, [...ranked, ...unranked].map((s) => s.actor), MONAD_TESTNET_ID);
  const view = (s: EntrantScore): StandingRow => ({
    actor: s.actor as `0x${string}`,
    displayName: labels.get(s.actor)?.displayName ?? null,
    avatarUrl: labels.get(s.actor)?.avatarUrl ?? null,
    net: s.net.toString(),
    won: s.won,
    settled: s.settled,
  });
  return { ranked: ranked.map(view), unranked: unranked.map(view), generatedAt: new Date().toISOString() };
}

/// Cached two minutes for everyone: the query aggregates every entrant, and the ledger itself moves every 30 minutes.
export const getCompetitionStandings = unstable_cache(() => readCompetitionStandings(db), ['competition-standings'], { revalidate: 120 });
