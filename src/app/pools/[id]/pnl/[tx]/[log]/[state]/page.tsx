import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { visitorIp } from '@/lib/avatar-budget';
import { cardPath, type ShareCard } from '@/lib/pnl-card';
import { loadCard } from '@/lib/pnl-card-server';

const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? 'https://makomarket.xyz').replace(/\/+$/, '');

type Params = Promise<{ id: string; tx: string; log: string; state: string }>;

const load = async (params: Params) => {
  const { id, tx, log, state } = await params;
  return { id, tx, log, state, c: await loadCard(id, tx, log, state, visitorIp({ headers: await headers() })) };
};

const summary = (card: ShareCard) =>
  card.variant === 'placed'
    ? `My call: ${card.side}.${card.est ? ` ${card.est.ret.sign}${card.est.ret.text} est. return if right.` : ''}`
    : `${card.ret.sign}${card.ret.text} on ${card.side}.`;

/// A shared card link unfurls as the card itself (./opengraph-image.tsx).
export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id, tx, log, c } = await load(params);
  if (!c.ok) return { title: 'Share card · Mako Market Beta' };
  const title = `${c.card.question} · Mako Market Beta`;
  const description = `${summary(c.card)} A prediction pool on Mako Market, on Monad testnet.`;
  const url = `${APP_URL}${cardPath(id, tx, log, c.state)}`;
  const image = `${url}/opengraph-image`;
  return {
    title,
    description,
    openGraph: { title, description, url, siteName: 'Mako Market', type: 'website', images: [{ url: image, width: 1600, height: 900, alt: c.card.question }] },
    twitter: { card: 'summary_large_image', title, description, images: [image] },
  };
}

/// /pools/[id]/pnl/[tx]/[log]/[state]: one bet's share card, the page a shared card links to, with a way into the pool.
/// A bet placed link whose pool has settled since goes on to that bet's result.
export default async function ShareCardPage({ params }: { params: Params }) {
  const { id, tx, log, c } = await load(params);
  if (!c.ok && c.reason === 'settled') redirect(cardPath(id, tx, log, 'result'));
  if (!c.ok && (c.reason === 'not_found' || c.reason === 'not_yet')) notFound();
  return (
    <section style={{ padding: '24px 16px', maxWidth: 1040, margin: '0 auto', color: 'var(--mako-canvas-fg)' }}>
      {c.ok ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`${cardPath(id, tx, log, c.state)}/opengraph-image`} width={1600} height={900} alt={c.card.question} style={{ display: 'block', width: '100%', height: 'auto', borderRadius: 16 }} />
      ) : (
        <p style={{ fontFamily: 'var(--mako-font-mono)', fontSize: 14 }}>
          {c.reason === 'refused' ? 'Too many requests just now. Try again in a minute.' : 'The chain could not be read just now. Try again in a minute.'}
        </p>
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
