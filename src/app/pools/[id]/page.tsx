import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { poolIdFrom, poolShare, poolUrl, readPoolForShare } from '@/lib/pool-share';

import { PoolClient } from './PoolClient';

const FALLBACK_TITLE = 'Pool · Mako Market Beta';

/// A shared pool link unfurls with the pool's own question and status (the image is ./opengraph-image.tsx).
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const poolId = poolIdFrom(id);
  const pool = poolId === null ? null : await readPoolForShare(poolId);
  if (!pool) return { title: FALLBACK_TITLE, openGraph: { title: FALLBACK_TITLE, url: poolUrl(id), siteName: 'Mako Market', type: 'website' } };
  const s = poolShare(pool, Math.floor(Date.now() / 1000));
  return {
    title: s.title,
    description: s.description,
    openGraph: { title: s.title, description: s.description, url: s.url, siteName: 'Mako Market', type: 'website', images: [{ url: s.image, width: 1200, height: 630, alt: s.alt }] },
    twitter: { card: 'summary_large_image', title: s.title, description: s.description, images: [s.image] },
  };
}

/// /pools/[id] (9a). `?side=yes|no` preselects the bet side (the Pools list's YES and NO buttons).
export default async function PoolPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ side?: string }> }) {
  const { id } = await params;
  const poolId = poolIdFrom(id);
  if (poolId === null) notFound();
  const { side } = await searchParams;
  return <PoolClient id={poolId} initialSide={side === 'yes' || side === 'no' ? side : null} />;
}
