import type { Metadata } from 'next';

import { Suspense } from 'react';

import { LeaderboardClient } from './_components/LeaderboardClient';
import { CompetitionTab } from './competition/CompetitionTab';

export const metadata: Metadata = { title: 'Leaderboard · Mako Market Beta' };

// Server shell + client body, as before: a prerendered page must never pin a stale board.
export const dynamic = 'force-dynamic';

/// Leaderboard (12a). The Competition tab is rendered here, on the server, and streams in without holding up the board.
export default function LeaderboardPage() {
  const tab = (compact: boolean) => (
    <Suspense fallback={<div role="status" style={{ padding: compact ? '16px 16px 0' : '0 4px', fontSize: 14, color: 'var(--dim)' }}>Loading the standings…</div>}>
      <CompetitionTab compact={compact} />
    </Suspense>
  );
  return <LeaderboardClient competition={{ desktop: tab(false), mobile: tab(true) }} />;
}
