'use client';

import { useQuery } from '@tanstack/react-query';

/**
 * Shape returned by `/api/admin/analytics`.
 *
 * All USDC values are pre-formatted to decimal strings on the server so
 * the payload is pure JSON-safe. The `*BaseUnits` siblings stay as
 * bigint-shaped strings (unformatted, 6-decimal base units) so the
 * client can sort exactly without going through float.
 *
 * USDC denomination: every `*Usdc` field is a string formatted via
 * `formatUsdcExact` (full 6dp precision) so downstream `parseFloat(...)`
 * sums and sort keys don't lose sub-cent precision.
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
  /**
   * Effective block range the server scanned. When `bounded` is true, the
   * scan is clipped by a lookback window (public RPC mitigation); volume-
   * and user-shape numbers that derive from event logs only cover this
   * window. Lifetime contract-state numbers (marketCount, treasuryUsdc)
   * still reflect the whole chain because they come from eth_call, not logs.
   */
  window: {
    fromBlock: string;
    toBlock: string;
    blocksCovered: string;
    bounded: boolean;
  };
  totals: {
    marketCount: number;
    resolvedCount: number;
    unresolvedOpenCount: number;
    pendingResolveCount: number;
    totalVolumeUsdc: string;
    uniqueBettors: number;
    uniqueCreators: number;
    /** Current USDC sitting in the contract awaiting `withdrawTreasury()`. */
    treasuryUsdc: string;
    /** Cumulative USDC paid out to creators via CreatorFeePaid events. */
    creatorFeesPaidUsdc: string;
    /** Cumulative protocol fees: treasuryUsdc + everything ever withdrawn. */
    totalProtocolFeesUsdc: string;
    fetchedAtSec: number;
  };
  users: Array<{
    address: `0x${string}`;
    betCount: number;
    volumeUsdc: string;
    /** Raw 6-decimal base units as a decimal string. Use for exact bigint sort. */
    volumeBaseUnits: string;
    marketsCreated: number;
    /** Cumulative USDC earned by this address as a creator (CreatorFeePaid sum). */
    creatorFeesEarnedUsdc: string;
    /** Raw 6-decimal base units for the same — use for exact bigint sort. */
    creatorFeesEarnedBaseUnits: string;
    /** Cumulative USDC this address claimed from winning bets (Claimed sum). */
    claimedUsdc: string;
    firstSeenSec: number;
    lastSeenSec: number;
  }>;
  markets: Array<{
    id: string;
    mType: 0 | 1 | 2 | 3 | 4 | 5 | 6;
    creator: `0x${string}`;
    question: string;
    createdAtSec: number;
    closeTimeSec: number;
    bettingCloseTimeSec: number;
    poolUsdc: string;
    yesUsdc: string;
    noUsdc: string;
    bettorCount: number;
    outcome: 0 | 1 | 2 | 3;
    resolved: boolean;
  }>;
  activity: Array<
    | { kind: 'bet'; marketId: string; txHash: `0x${string}`; blockNumber: string; tsSec: number; user: `0x${string}`; amountUsdc: string; isYes: boolean }
    | { kind: 'market'; marketId: string; txHash: `0x${string}`; blockNumber: string; tsSec: number; user: `0x${string}` }
    /// Resolve rows are enriched server-side with `mType` (from the
    /// existing markets lookup the analytics route already builds)
    /// and `labels` (a single batched `getMakoLabelsBatch` call for
    /// the MAKO subset of resolve marketIds). `labels` is non-null
    /// ONLY when `mType === MAKO` AND a DB row exists; null in every
    /// other case. ActivityRow uses these directly via
    /// `outcomeLabelForMarket({ mType: a.mType }, a.labels, a.outcome)`
    /// — no client-side hook, no per-row fetch.
    | {
        kind: 'resolve';
        marketId: string;
        txHash: `0x${string}`;
        blockNumber: string;
        tsSec: number;
        outcome: 0 | 1 | 2 | 3;
        mType: 0 | 1 | 2 | 3 | 4 | 5 | 6;
        labels: { label1: string; label2: string } | null;
      }
    | { kind: 'claim'; marketId: string; txHash: `0x${string}`; blockNumber: string; tsSec: number; user: `0x${string}`; amountUsdc: string }
    | { kind: 'fee'; marketId: string; txHash: `0x${string}`; blockNumber: string; tsSec: number; user: `0x${string}`; amountUsdc: string }
  >;
  /**
   * Daily active wallets for the last 30 days.
   * `dateISO` is UTC YYYY-MM-DD. `wallets` is the count of unique bettor
   * addresses that placed at least one bet on that day. `bets` is the
   * number of bet transactions that day. Empty days are present with zero
   * counts so the chart can render a continuous 30-bar strip.
   */
  dau: Array<{ dateISO: string; wallets: number; bets: number }>;
  /**
   * Cumulative unique users over the last 30 days. A "user" is any address
   * that has placed a bet OR created a market (matches the /admin/users
   * roster). `cumulativeUsers` at each day is the running total of distinct
   * addresses ever seen up to and including that day — pre-window users
   * are folded into the first day's count so the curve starts at the real
   * baseline, not zero. `newUsers` is first-timers that day only.
   */
  userGrowth: Array<{ dateISO: string; cumulativeUsers: number; newUsers: number }>;
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
/** Sentinel the admin pages check for to swap the error view for the SIWE
 * login panel. A thrown Error.message of exactly this string means: wallet
 * is admin-address, but there's no valid session cookie — render AdminLogin. */
export const UNAUTHORIZED = 'UNAUTHORIZED' as const;

export function useAdminAnalytics(opts: { enabled?: boolean } = {}) {
  return useQuery<AdminAnalytics>({
    queryKey: ['admin-analytics'],
    enabled: opts.enabled ?? true,
    queryFn: async () => {
      const res = await fetch('/api/admin/analytics', { cache: 'no-store' });
      if (res.status === 401) throw new Error(UNAUTHORIZED);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as AdminAnalytics;
    },
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
    // Don't retry on 401 — SIWE login must happen before a retry is useful.
    retry: (failureCount, err) => {
      if (err instanceof Error && err.message === UNAUTHORIZED) return false;
      return failureCount < 3;
    },
  });
}
