import LeaderboardClient from './_components/LeaderboardClient';

// Server shell + Client body, same pattern as / and /create (prerender
// cache must never pin a stale board; the body is wagmi/TanStack-driven).
export const dynamic = 'force-dynamic';

export default function LeaderboardPage() {
  return <LeaderboardClient />;
}
