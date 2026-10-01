// /stats ("proof of demand"): the figures, read from Mako Market's Envio indexer (indexer/ in this repo) and checked
// before use. A missing or malformed answer is an error the page shows as such, never a zero.
//
// The indexer keeps its own running totals (Envio Cloud serves no aggregate queries), so one GraphQL request
// returns everything the page needs. Amounts are USDC base units; times are Unix seconds.

import { z } from 'zod';

/// The query sent to the indexer's GraphQL endpoint (Hasura). Field names are the indexer's schema.graphql.
export const STATS_QUERY = `query Stats {
  GlobalStats(where: { id: { _eq: "global" } }) {
    wallets bettors bets volume pools communityPools poolsSettled poolsRefunded claims claimed creatorFeesPaid
    updatedAt updatedBlock
  }
  DailyStats(order_by: { dayStart: asc }) { id dayStart newWallets activeWallets bets volume cumulativeWallets }
  CategoryStats { category pools bets volume }
  Bet(order_by: { timestamp: desc }, limit: 12) { id wallet_id pool_id isYes amount timestamp txHash }
  Claim(order_by: { timestamp: desc }, limit: 12) { id wallet_id pool_id amount timestamp txHash }
}`;

/// A BigInt column as Hasura returns it (a string, or a number for small values), as a bigint.
const big = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]).transform((v) => BigInt(v));
const count = z.number().int().nonnegative();
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((a) => a.toLowerCase());

const Response = z.object({
  data: z.object({
    GlobalStats: z.array(
      z.object({
        wallets: count,
        bettors: count,
        bets: count,
        volume: big,
        pools: count,
        communityPools: count,
        poolsSettled: count,
        poolsRefunded: count,
        claims: count,
        claimed: big,
        creatorFeesPaid: big,
        updatedAt: count,
        updatedBlock: count,
      }),
    ),
    DailyStats: z.array(
      z.object({
        id: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        dayStart: count,
        newWallets: count,
        activeWallets: count,
        bets: count,
        volume: big,
        cumulativeWallets: count,
      }),
    ),
    CategoryStats: z.array(z.object({ category: z.string(), pools: count, bets: count, volume: big })),
    Bet: z.array(z.object({ id: z.string(), wallet_id: address, pool_id: z.string().regex(/^\d+$/), isYes: z.boolean(), amount: big, timestamp: count, txHash: hash })),
    Claim: z.array(z.object({ id: z.string(), wallet_id: address, pool_id: z.string().regex(/^\d+$/), amount: big, timestamp: count, txHash: hash })),
  }),
});

export type StatsActivity = {
  kind: 'bet' | 'claim';
  wallet: string;
  poolId: string;
  amount: bigint;
  /// Bets only: the side.
  isYes: boolean | null;
  timestamp: number;
  txHash: string;
};

export type IndexedStats = {
  global: z.output<typeof Response>['data']['GlobalStats'][number];
  days: z.output<typeof Response>['data']['DailyStats'];
  categories: z.output<typeof Response>['data']['CategoryStats'];
  /// Newest first, bets and claims together.
  activity: StatsActivity[];
};

/// The indexer's answer, checked. Null for anything that is not a complete, well-formed answer: an error body, a
/// missing field, a wrong type, or no GlobalStats row yet (the indexer has not processed its first event).
export function parseIndexedStats(body: unknown, activityLimit = 12): IndexedStats | null {
  const parsed = Response.safeParse(body);
  if (!parsed.success) return null;
  const d = parsed.data.data;
  const global = d.GlobalStats[0];
  if (!global) return null;
  const activity: StatsActivity[] = [
    ...d.Bet.map((b) => ({ kind: 'bet' as const, wallet: b.wallet_id, poolId: b.pool_id, amount: b.amount, isYes: b.isYes, timestamp: b.timestamp, txHash: b.txHash })),
    ...d.Claim.map((c) => ({ kind: 'claim' as const, wallet: c.wallet_id, poolId: c.pool_id, amount: c.amount, isYes: null, timestamp: c.timestamp, txHash: c.txHash })),
  ]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, activityLimit);
  return { global, days: d.DailyStats, categories: d.CategoryStats, activity };
}

/// What the page shows, as it travels from /api/stats to the browser (bigints as decimal strings).
export type StatsWire = {
  indexed: {
    wallets: number;
    bettors: number;
    bets: number;
    volume: string;
    pools: number;
    communityPools: number;
    poolsSettled: number;
    poolsRefunded: number;
    claims: number;
    claimed: string;
    updatedAt: number;
    updatedBlock: number;
    growth: { day: string; cumulativeWallets: number; newWallets: number; bets: number }[];
    categories: { category: string; pools: number; bets: number; volume: string }[];
    activity: { kind: 'bet' | 'claim'; wallet: string; poolId: string; amount: string; isYes: boolean | null; timestamp: number; txHash: string }[];
  } | null;
  /// Why `indexed` is null: the indexer's URL is not set yet, or it did not give a usable answer.
  indexedStatus: 'ok' | 'not_configured' | 'unavailable';
  /// Sponsored (gas-free) user operations that landed, from Mako Market's own records; each has a transaction hash.
  gasFree: { actions: number; accounts: number } | null;
  /// When /api/stats read these figures.
  readAt: number;
};

export function toWire(
  stats: IndexedStats | null,
  indexedStatus: StatsWire['indexedStatus'],
  gasFree: StatsWire['gasFree'],
  readAt: number,
): StatsWire {
  return {
    indexedStatus: stats ? 'ok' : indexedStatus === 'ok' ? 'unavailable' : indexedStatus,
    indexed: stats && {
      wallets: stats.global.wallets,
      bettors: stats.global.bettors,
      bets: stats.global.bets,
      volume: stats.global.volume.toString(),
      pools: stats.global.pools,
      communityPools: stats.global.communityPools,
      poolsSettled: stats.global.poolsSettled,
      poolsRefunded: stats.global.poolsRefunded,
      claims: stats.global.claims,
      claimed: stats.global.claimed.toString(),
      updatedAt: stats.global.updatedAt,
      updatedBlock: stats.global.updatedBlock,
      growth: stats.days.map((d) => ({ day: d.id, cumulativeWallets: d.cumulativeWallets, newWallets: d.newWallets, bets: d.bets })),
      categories: stats.categories.map((c) => ({ category: c.category, pools: c.pools, bets: c.bets, volume: c.volume.toString() })),
      activity: stats.activity.map((a) => ({ ...a, amount: a.amount.toString() })),
    },
    gasFree,
    readAt,
  };
}

/// The growth chart's line and area in a `w` x `h` box: evenly spaced days, the highest value 8px under the top, zero
/// at the bottom. One day draws a flat line at its value; no days draws nothing.
export function growthPaths(values: readonly number[], w: number, h: number): { line: string; area: string } | null {
  if (values.length === 0) return null;
  const vals = values.length === 1 ? [values[0], values[0]] : values;
  const max = Math.max(1, ...vals);
  const x = (i: number) => (i / (vals.length - 1)) * w;
  const y = (v: number) => h - (v / max) * (h - 8);
  const line = vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  return { line, area: `${line} L${w} ${h} L0 ${h} Z` };
}
