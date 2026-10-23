import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { visitorIp } from '@/lib/avatar-budget';
import { cardPath } from '@/lib/pnl-card';
import { loadCard } from '@/lib/pnl-card-server';

const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? 'https://makomarket.xyz').replace(/\/+$/, '');

type Params = Promise<{ id: string; tx: string; log: string }>;

const load = async (params: Params) => {
  const { id, tx, log } = await params;
  return { id, tx, log, c: await loadCard(id, tx, log, visitorIp({ headers: await headers() })) };
};

/// A shared card link unfurls as the card itself (./opengraph-image.tsx).
export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id, tx, log, c } = await load(params);
  if (!c.ok) return { title: 'PnL card · Mako Market Beta' };
  const title = `${c.card.question} · Mako Market Beta`;
  const description = `${c.card.ret.sign}${c.card.ret.text} on ${c.card.side}. A prediction pool on Mako Market, on Monad testnet.`;
  const url = `${APP_URL}${cardPath(id, tx, log)}`;
  const image = `${url}/opengraph-image`;
  return {
    title,
    description,
    openGraph: { title, description, url, siteName: 'Mako Market', type: 'website', images: [{ url: image, width: 1600, height: 900, alt: c.card.question }] },
    twitter: { card: 'summary_large_image', title, description, images: [image] },
  };
}

/// /pools/[id]/pnl/[tx]/[log]: one bet's PnL card, the page a shared card links to, with a way into the pool.
export default async function PnlCardPage({ params }: { params: Params }) {
  const { id, tx, log, c } = await load(params);
  if (!c.ok && c.reason === 'not_found') notFound();
  return (
    <section style={{ padding: '24px 16px', maxWidth: 1040, margin: '0 auto', color: 'var(--mako-canvas-fg)' }}>
      {c.ok ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`${cardPath(id, tx, log)}/opengraph-image`} width={1600} height={900} alt={c.card.question} style={{ display: 'block', width: '100%', height: 'auto', borderRadius: 16 }} />
      ) : (
        <p style={{ fontFamily: 'var(--mako-font-mono)', fontSize: 14 }}>Too many requests just now. Try again in a minute.</p>
      )}
      <Link
        href={`/pools/${id}`}
        className="mk-press96"
        style={{ display: 'inline-flex', alignItems: 'center', height: 44, padding: '0 20px', marginTop: 16, borderRadius: 9999, background: 'var(--mako-signal)', color: '#000', boxShadow: 'var(--edge)', fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: 15, textDecoration: 'none' }}
      >
        See the pool
      </Link>
    </section>
  );
}
