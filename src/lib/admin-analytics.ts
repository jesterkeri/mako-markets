'use client';

import { useQuery } from '@tanstack/react-query';

/**
 * Shape returned by `/api/admin/analytics`.
 *
 * All `bigint` values are pre-formatted to decimal strings on the server
 * so the payload is pure JSON-safe. Client components format for display
 * without needing to parse bigints.
 */
export type AdminAnalytics = {
  totals: {
    marketCount: number;
    resolvedCount: number;
    unresolvedOpenCount: number;
    pendingResolveCount: number;
    totalVolumeMon: string;
    uniqueBettors: number;
    uniqueCreators: number;
    treasuryMon: string;
    fetchedAtSec: number;
  };
  users: Array<{
    address: `0x${string}`;
    betCount: number;
    volumeMon: string;
    marketsCreated: number;
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
 * `staleTime: 30_000` means navigating between admin tabs inside the
 * 30s window reuses the in-memory cache — the browser never re-fetches.
 * `refetchInterval: 30_000` picks up fresh server data on schedule so
 * tiles drift forward without the admin having to reload.
 *
 * The server route applies its own 30s module-scoped memo, so even if
 * several clients refetch at the same tick, Monad RPC sees one fanout.
 */
export function useAdminAnalytics() {
  return useQuery<AdminAnalytics>({
    queryKey: ['admin-analytics'],
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
