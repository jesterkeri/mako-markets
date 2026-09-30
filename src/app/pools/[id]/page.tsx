import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { PoolClient } from './PoolClient';

export const metadata: Metadata = { title: 'Pool · Mako Market' };

/// /pools/[id] (9a). `?side=yes|no` preselects the bet side (the Pools list's YES and NO buttons).
export default async function PoolPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ side?: string }> }) {
  const { id } = await params;
  if (!/^\d{1,18}$/.test(id)) notFound();
  const { side } = await searchParams;
  return <PoolClient id={BigInt(id)} initialSide={side === 'yes' || side === 'no' ? side : null} />;
}
