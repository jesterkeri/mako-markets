// ----------------------------------------------------------------------------
// #186 Leaderboard — TanStack hook over GET /api/leaderboard.
//
// Mirrors the useAdminAnalytics pattern. The wire types below duplicate
// the route's response shape on purpose: the route module imports
// server-only code (db/client) and must never be imported from client
// components — /api/leaderboard/route.ts is the source of truth for
// the shape.
//
// `me` is the caller's ON-CHAIN identity (Magic users: their Safe
// address; wallet users: the connected wallet) — it only affects the
// per-user `viewer` block, never the shared board (the server caches
// the board keyed by window alone).
// ----------------------------------------------------------------------------

import { useQuery } from '@tanstack/react-query';

export type LeaderboardWindow = 'all' | 'week';

export interface LeaderboardWireRow {
  actor: `0x${string}`;
  /// USDC base units (6dp) as exact decimal strings — convert with
  /// BigInt(), never Number().
  staked: string;
  won: string;
  net: string;
  bets: number;
  creatorFees: string;
  displayName: string | null;
}

export interface LeaderboardWireViewer extends LeaderboardWireRow {
  rank: number;
}

export interface LeaderboardWire {
  window: LeaderboardWindow;
  rows: LeaderboardWireRow[];
  /// absent = caller is on the board (or no `me`); null = caller has no
  /// events in this window; object = off-board row + rank.
  viewer?: LeaderboardWireViewer | null;
  /// Block height the board is complete up to; null until the one-time
  /// seed backfill has run.
  indexedThrough: number | null;
  generatedAt: string;
}

/// Matches the server's board revalidation window (45s) so the client
/// re-pulls roughly when a fresh board can exist.
const REFETCH_MS = 45_000;

export function useLeaderboard(window: LeaderboardWindow, me?: string) {
  return useQuery<LeaderboardWire>({
    queryKey: ['leaderboard', window, me?.toLowerCase() ?? 'anon'],
    queryFn: async () => {
      const params = new URLSearchParams({ window });
      if (me) params.set('me', me);
      const res = await fetch(`/api/leaderboard?${params.toString()}`);
      if (!res.ok) {
        throw new Error(`leaderboard fetch failed: ${res.status}`);
      }
      return (await res.json()) as LeaderboardWire;
    },
    refetchInterval: REFETCH_MS,
  });
}
