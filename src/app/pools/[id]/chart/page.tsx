import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { poolIdFrom } from '@/lib/pool-share';

import { PoolChartClient } from './PoolChartClient';

export const metadata: Metadata = { title: 'Price chart · Mako Market Beta' };

/// /pools/[id]/chart: the pool's full price chart as its own page.
export default async function PoolChartPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const poolId = poolIdFrom(id);
  if (poolId === null) notFound();
  return <PoolChartClient id={poolId} />;
}
