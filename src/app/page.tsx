'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useMarkets } from '@/lib/hooks';
import { MarketType } from '@/lib/contract';
import { MarketCard } from '@/components/MarketCard';
import { AuthMenu } from '@/components/AuthMenu';
import { MobileChromeHeader } from '@/components/MobileChromeHeader';
import { ThemeToggle } from '@/components/ThemeToggle';

type Tab = 'all' | 'crypto' | 'football' | 'nba';

const TAB_TO_MTYPE: Partial<Record<Tab, MarketType>> = {
  crypto: MarketType.CRYPTO,
  football: MarketType.FOOTBALL,
  nba: MarketType.BASKETBALL,
};

/**
 * Each category pill gets its own base fill so the row reads as a palette,
 * not a wall of identical buttons. Active state presses 1px up/left with a
 * 4×4 contrasting shadow to pop. Idle state has a 2px flat shadow so the
 * chips still feel three-dimensional.
 *
 * Color assignment:
 *  - ALL      → paper (neutral anchor)       · red active shadow
 *  - FOOTBALL → signal (yellow)              · ink active shadow
 *  - CRYPTO   → mako-red (destructive accent)· ink active shadow
 *  - NBA      → ink (negative space)         · signal active shadow
 */
const TABS: Array<{
  key: Tab;
  label: string;
  bg: string;
  text: string;
  activeShadow: string;
}> = [
  {
    key: 'all',
    label: 'ALL',
    bg: 'bg-paper',
    text: 'text-ink',
    activeShadow: 'shadow-[4px_4px_0_0_#D94A3D]',
  },
  {
    key: 'football',
    label: 'FOOTBALL',
    bg: 'bg-signal',
    text: 'text-ink',
    activeShadow: 'shadow-brutal',
  },
  {
    key: 'crypto',
    label: 'CRYPTO',
    bg: 'bg-mako-red',
    text: 'text-paper',
    activeShadow: 'shadow-brutal',
  },
  {
    key: 'nba',
    label: 'NBA',
    bg: 'bg-ink',
    text: 'text-paper',
    activeShadow: 'shadow-[4px_4px_0_0_#FACC15]',
  },
];

const EMPTY_COPY: Record<Tab, string> = {
  all: 'No open markets yet.',
  crypto: 'No crypto markets open.',
  football: 'No football markets open.',
  nba: 'No NBA markets open.',
};


export default function Home() {
  const { markets, isLoading } = useMarkets();
  const [tab, setTab] = useState<Tab>('all');
  const [nowSec, setNowSec] = useState(() => BigInt(Math.floor(Date.now() / 1000)));

  useEffect(() => {
    const id = setInterval(() => {
      setNowSec(BigInt(Math.floor(Date.now() / 1000)));
    }, 10_000);
    return () => clearInterval(id);
  }, []);

  const tabMType = TAB_TO_MTYPE[tab];
  // v4 splits "betting open?" (bettingCloseTime) from "resolution legal?"
  // (closeTime). The home feed shows still-bettable markets, so the filter
  // gates on bettingCloseTime — markets sitting in their resolution window
  // (sports between bettingCloseTime and closeTime) drop out of the feed.
  const filtered = markets.filter((m) => {
    if (m.resolved) return false;
    if (m.bettingCloseTime <= nowSec) return false;
    if (tabMType !== undefined && m.mType !== tabMType) return false;
    return true;
  });

  return (
    <main className="flex-1 flex flex-col min-h-screen">
      <MobileChromeHeader />

      <div className="flex-1 w-full flex flex-col">
        {/* Top header bar — fixed h-12 matches the Sidebar brand row and
            MarketIntelAside header so the bottom border line runs
            continuous across all three columns. Sticky so it stays flush
            with MarketIntelAside (also sticky) when the feed scrolls. */}
        <header className="hidden md:flex items-center justify-between px-6 lg:px-8 h-12 border-b-2 border-chrome-divider bg-chrome text-chrome-fg sticky top-0 z-30">
          <h1 className="mako-display text-sm lg:text-base text-chrome-fg">LIVE MARKETS</h1>
          <div className="flex items-center gap-2">
            {/* Top-header auth slot. Phase 1G Group 5A: identity pill
                (avatar + display name → /profile) sits leftmost in the
                cluster so the user's "this is me" affordance is the
                first thing scanned, ahead of the action chrome
                (theme toggle, NEW MARKET). Was acquisition-only /
                SIGN IN before; now always rendered. */}
            <AuthMenu className="px-3! py-1.5! text-[11px]!" />
            <ThemeToggle />
            <Link
              href="/create"
              className="mako-button mako-button--signal mako-label px-3! py-1.5! text-[11px]!"
            >
              + NEW MARKET
            </Link>
          </div>
        </header>

        <div className="px-4 sm:px-6 lg:px-8 py-5 md:py-6 max-w-6xl mx-auto w-full">
            {/* Mobile heading — the desktop version lives in the flush header bar above */}
            <div className="flex items-baseline justify-between mb-6 md:hidden">
              <h1 className="mako-display text-[clamp(1.875rem,3vw,2.25rem)] text-canvas-fg">LIVE MARKETS</h1>
            </div>

            {/* Category tabs — each in its own brand color. See TABS above.
                flex-wrap + no overflow-x-auto so the active pill's 4×4 red
                shadow has room to breathe instead of being clipped by the
                scroll container's implicit overflow-y. */}
            <nav className="flex items-center gap-3 mb-6 flex-wrap">
              {TABS.map(({ key, label, bg, text, activeShadow }) => {
                const isActive = tab === key;
                return (
                  <button
                    key={key}
                    onClick={() => setTab(key)}
                    aria-current={isActive ? 'page' : undefined}
                    className={`
                      mako-label px-4 py-2 rounded-full border-2 border-ink transition-all
                      whitespace-nowrap ${bg} ${text}
                      ${isActive
                        ? `${activeShadow} -translate-y-[2px] -translate-x-[2px]`
                        : 'shadow-brutal-sm hover:shadow-brutal hover:-translate-y-[1px] hover:-translate-x-[1px]'}
                    `}
                  >
                    {label}
                  </button>
                );
              })}
            </nav>

            {isLoading && filtered.length === 0 ? (
              <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-5">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="mako-skeleton h-[220px]" aria-hidden="true" />
                ))}
              </div>
            ) : filtered.length > 0 ? (
              <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-5">
                {filtered.map((market) => (
                  <Link
                    key={market.id.toString()}
                    href={`/market/${market.id.toString()}`}
                    className="block h-full"
                  >
                    <MarketCard market={market} />
                  </Link>
                ))}
              </div>
            ) : (
              <div className="rotate-2 transform mt-12 max-w-md mx-auto">
                <div className="bg-paper border-2 border-ink rounded-xl shadow-brutal p-6 text-center mako-title text-xl">
                  {EMPTY_COPY[tab]}
                </div>
              </div>
          )}
        </div>
      </div>
    </main>
  );
}
