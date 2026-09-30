import type { Metadata } from 'next';

import { LeaderboardClient } from './_components/LeaderboardClient';

export const metadata: Metadata = { title: 'Leaderboard · Mako Market Beta' };

// Server shell + client body, as before: a prerendered page must never pin a stale board.
export const dynamic = 'force-dynamic';

/// Leaderboard (12a).
export default function LeaderboardPage() {
  return <LeaderboardClient />;
}
