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
  /// True while any contract is mid-backfill — the board may be built
  /// from oldest events only and must NOT be presented as
  /// authoritative (drives the SYNCING banner).
  syncing: boolean;
  generatedAt: string;
}

/// #191-4 poll hardening: 90s (was 45s). The shared board is an
/// unstable_cache(revalidate: 45s) — Next's request-driven
/// stale-while-revalidate, NOT proactive: the poll that crosses the window
/// serves the STALE board and only triggers background regeneration, so the
/// refreshed board is not shown until a LATER poll observes it. Displayed rows
/// can therefore stay stale across multiple polls (worst case on the order of
/// revalidate + 2× interval in low traffic); generatedAt exposes the true age
/// and the UI surfaces staleness. What 90s actually cuts is the per-viewer
/// `viewer`-block query rate — that block is computed LIVE outside the cache,
/// so it scales with poll frequency under concurrency. A net-PnL board on a
/// 30-min recompute cron does not need sub-minute polls.
const REFETCH_MS = 90_000;

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
    // #191-4: pin TanStack's existing default (hidden tabs already skip
    // interval refetch) as a guard against a global QueryClient override.
    // Preserves the idle path — a board nobody is viewing issues no live
    // `viewer` queries.
    refetchIntervalInBackground: false,
  });
}
