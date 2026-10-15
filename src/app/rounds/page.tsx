import type { Metadata } from 'next';

import { RoundsClient } from './RoundsClient';

export const metadata: Metadata = { title: 'Rounds · Mako Market Beta' };

/// /rounds: the first tab. The Rounds contract is not live yet, so the page says so and points to Pools rather
/// than showing an empty schedule that nobody can fill. `?results=all` lists every result, not only the latest few.
export default async function RoundsPage({ searchParams }: { searchParams: Promise<{ results?: string | string[] }> }) {
  const { results } = await searchParams;
  return <RoundsClient allResults={results === 'all'} />;
}
