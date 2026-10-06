import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { RoundClient } from './RoundClient';

export const metadata: Metadata = { title: 'Round · Mako Market Beta' };

/// A round id as a positive whole number, or null.
function roundIdFrom(raw: string): bigint | null {
  if (!/^[1-9]\d{0,18}$/.test(raw)) return null;
  return BigInt(raw);
}

/// /rounds/[id]: one round. `?side=up|down` preselects the side.
export default async function RoundPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ side?: string }> }) {
  const { id } = await params;
  const roundId = roundIdFrom(id);
  if (roundId === null) notFound();
  const { side } = await searchParams;
  return <RoundClient id={roundId} initialSide={side === 'up' || side === 'down' ? side : null} />;
}
