// ----------------------------------------------------------------------------
// src/app/m/[slug]/page.tsx
//
// Phase 2C-2 Step 10b: minimal shared-market stub. Phase 2E expands
// this into the full market view (option pools, stake button,
// livestream embed). The URL stays stable so external shares from
// 2C-2 onwards stay valid.
//
// Server Component:
//   - getMarketBySlug(slug) — 2B-2 query that returns active markets
//     (createStatus IN 'pending'|'confirmed'). Failed/abandoned rows
//     don't surface here.
//   - notFound() on miss.
//   - headers()-derived origin for the share URL so CopyLinkButton
//     works identically on localhost, beta.makomarket.xyz, and
//     makomarket.xyz.
//
// Theme: brand tokens only. Dual-theme verified via /m/<slug> with
// <ThemeToggle /> in plan v6 step 12.
// ----------------------------------------------------------------------------

import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { getMarketBySlug } from '@/lib/private-markets/queries';

import { CopyLinkButton } from './_components/CopyLinkButton';

interface MarketPageProps {
  params: Promise<{ slug: string }>;
}

const SHAPE_LABEL: Record<'friendly' | 'open_vote' | 'prize_pool', string> = {
  friendly: 'FRIENDLY',
  open_vote: 'OPEN VOTE',
  prize_pool: 'PRIZE POOL',
};

const SHAPE_BADGE_CLASS: Record<
  'friendly' | 'open_vote' | 'prize_pool',
  string
> = {
  friendly: 'bg-mako-red text-paper',
  open_vote: 'bg-signal text-ink',
  prize_pool: 'bg-ink text-paper',
};

function formatTimestamp(d: Date): string {
  // Stable display format that doesn't depend on locale-specific
  // rendering. The 2E expansion will replace this with proper
  // relative-time + tz-aware copy.
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

export default async function MarketStubPage({ params }: MarketPageProps) {
  const { slug } = await params;

  const market = await getMarketBySlug(slug);
  if (!market) {
    notFound();
  }

  // Derive origin from request headers so the copy URL works on every
  // surface. Vercel sets x-forwarded-host + x-forwarded-proto; local
  // dev exposes host. If both are absent (should not happen on
  // Vercel), fall back to a relative path — the clipboard copy still
  // resolves when the user pastes it into a browser on the same host.
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? '';
  const proto =
    h.get('x-forwarded-proto') ??
    (host.startsWith('localhost') ? 'http' : 'https');
  const origin = host ? `${proto}://${host}` : '';
  const shareUrl = origin ? `${origin}/m/${slug}` : `/m/${slug}`;

  return (
    <div className="bg-canvas text-canvas-fg min-h-screen py-12 px-4 sm:px-6 lg:px-8 flex flex-col items-center">
      <div className="max-w-2xl w-full space-y-6">
        <div
          className={`inline-block px-3 py-1 font-bold text-sm uppercase rounded-full border-2 border-ink shadow-brutal-sm ${SHAPE_BADGE_CLASS[market.shape]}`}
        >
          {SHAPE_LABEL[market.shape]}
        </div>

        <h1 className="font-display font-bold text-4xl sm:text-5xl uppercase leading-tight">
          {market.title || 'UNTITLED MARKET'}
        </h1>

        <div className="font-bold uppercase tracking-wide">
          {market.createStatus === 'confirmed' ? (
            <span>MARKET CREATED · FULL VIEW COMING SOON</span>
          ) : (
            <span className="text-muted">
              PENDING CONFIRMATION · REFRESH IN A MOMENT
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 border-y-2 border-ink py-4">
          <div className="flex flex-col">
            <span className="text-sm font-bold uppercase text-muted">
              OPENS
            </span>
            <span className="font-mono font-bold">
              {formatTimestamp(market.stakingOpensAt)}
            </span>
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-bold uppercase text-muted">
              CLOSES
            </span>
            <span className="font-mono font-bold">
              {formatTimestamp(market.closeAt)}
            </span>
          </div>
        </div>

        <div className="pt-4">
          <CopyLinkButton url={shareUrl} />
        </div>

        <div className="pt-12">
          <Link
            href="/"
            className="font-bold uppercase hover:text-link-hover transition-colors"
          >
            ← BACK TO HOME
          </Link>
        </div>
      </div>
    </div>
  );
}
