'use client';

import { useQuery } from '@tanstack/react-query';

/**
 * Shape returned by `/api/admin/analytics`.
 *
 * All `bigint` values are pre-formatted to decimal strings on the server
 * so the payload is pure JSON-safe. `volumeWei` stays as a bigint-shaped
 * string (unformatted) alongside `volumeMon` so the client can sort by
 * raw wei without going through float.
 */
export type AdminAnalytics = {
  /**
   * Non-empty when one or more event log streams failed during aggregation.
   * Each entry is a short stream name: 'bet' | 'market' | 'resolve' |
   * 'claim' | 'fee' | 'withdraw'. When any of these are present, the UI
   * must show a "DEGRADED" banner — totals and user rows derived from
   * the missing stream are silently wrong otherwise.
   */
  degraded: string[];
  totals: {
    marketCount: number;
    resolvedCount: number;
    unresolvedOpenCount: number;
    pendingResolveCount: number;
    totalVolumeMon: string;
    uniqueBettors: number;
    uniqueCreators: number;
    /** Current MON sitting in the contract awaiting `withdrawTreasury()`. */
    treasuryMon: string;
    /** Cumulative MON paid out to creators via CreatorFeePaid events. */
    creatorFeesPaidMon: string;
    /** Cumulative protocol fees: treasuryMon + everything ever withdrawn. */
    totalProtocolFeesMon: string;
    fetchedAtSec: number;
  };
  users: Array<{
    address: `0x${string}`;
    betCount: number;
    volumeMon: string;
    /** Raw wei as a decimal string. Use for exact bigint sort on the client. */
    volumeWei: string;
    marketsCreated: number;
    /** Cumulative MON earned by this address as a creator (CreatorFeePaid sum). */
    creatorFeesEarnedMon: string;
    /** Cumulative MON this address claimed from winning bets (Claimed sum). */
    claimedMon: string;
    firstSeenSec: number;
    lastSeenSec: number;
  }>;
  markets: Array<{
    id: string;
    mType: 0 | 1 | 2;
    creator: `0x${string}`;
    question: string;
    createdAtSec: number;
    closeTimeSec: number;
    poolMon: string;
    yesMon: string;
    noMon: string;
    bettorCount: number;
    outcome: 0 | 1 | 2 | 3;
    resolved: boolean;
  }>;
  activity: Array<
    | { kind: 'bet'; marketId: string; txHash: `0x${string}`; blockNumber: string; tsSec: number; user: `0x${string}`; amountMon: string; isYes: boolean }
    | { kind: 'market'; marketId: string; txHash: `0x${string}`; blockNumber: string; tsSec: number; user: `0x${string}` }
    | { kind: 'resolve'; marketId: string; txHash: `0x${string}`; blockNumber: string; tsSec: number; outcome: 0 | 1 | 2 | 3 }
    | { kind: 'claim'; marketId: string; txHash: `0x${string}`; blockNumber: string; tsSec: number; user: `0x${string}`; amountMon: string }
    | { kind: 'fee'; marketId: string; txHash: `0x${string}`; blockNumber: string; tsSec: number; user: `0x${string}`; amountMon: string }
  >;
  /**
   * Daily active wallets for the last 30 days.
   * `dateISO` is UTC YYYY-MM-DD. `wallets` is the count of unique bettor
   * addresses that placed at least one bet on that day. `bets` is the
   * number of bet transactions that day. Empty days are present with zero
   * counts so the chart can render a continuous 30-bar strip.
   */
  dau: Array<{ dateISO: string; wallets: number; bets: number }>;
};

/**
 * Shared fetch key + TanStack Query hook used by every /admin/* page.
 *
 * Pass `{ enabled: isAdmin }` so the fetch only fires for the admin wallet.
 * Without this gate every page load — including disconnected + non-admin
 * visitors — would hit the public analytics route and join the 30s poll
 * loop behind the NOT AUTHORIZED screen.
 *
 * `staleTime` + `refetchInterval` both 30_000 means navigating between
 * admin tabs inside the window reuses the in-memory cache; one HTTP hit
 * per 30s per client regardless of tab count. The server route adds its
 * own 30s memo so concurrent clients still see one RPC fanout.
 */
export function useAdminAnalytics(opts: { enabled?: boolean } = {}) {
  return useQuery<AdminAnalytics>({
    queryKey: ['admin-analytics'],
    enabled: opts.enabled ?? true,
    queryFn: async () => {
      const res = await fetch('/api/admin/analytics', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as AdminAnalytics;
    },
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
  });
}
