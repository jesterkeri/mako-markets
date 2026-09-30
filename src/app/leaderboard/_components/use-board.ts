'use client';

import { useQuery } from '@tanstack/react-query';

import type { BoardPeriod, BoardSort, BoardWire } from '@/lib/leaderboard/board-view';

/// 90 seconds, as the previous board polled (#191-4). The board is a shared 45-second server cache over a ledger the
/// indexer refreshes every 30 minutes, so polling faster buys nothing. Hidden tabs do not poll.
const REFETCH_MS = 90_000;

/// GET /api/leaderboard for one period and sort. `me` is the signed-in account's address; it only adds the caller's
/// own rank (`viewer`), never changes the shared board. `enabled` holds the request until the account is known, so
/// a signed-in viewer does not fetch twice.
export function useBoard(period: BoardPeriod, sort: BoardSort, me: string | null, enabled: boolean) {
  return useQuery<BoardWire>({
    queryKey: ['leaderboard', period, sort, me?.toLowerCase() ?? 'anon'],
    queryFn: async () => {
      const params = new URLSearchParams({ window: period, sort });
      if (me) params.set('me', me);
      const res = await fetch(`/api/leaderboard?${params.toString()}`);
      if (!res.ok) throw new Error(`leaderboard ${res.status}`);
      return (await res.json()) as BoardWire;
    },
    enabled,
    refetchInterval: REFETCH_MS,
    refetchIntervalInBackground: false,
  });
}
