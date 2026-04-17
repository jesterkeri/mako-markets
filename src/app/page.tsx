'use client';

import { useState, useEffect } from 'react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useMarkets } from '@/lib/hooks';
import { MarketType } from '@/lib/contract';
import { MarketCard } from '@/components/MarketCard';
import { PriceTicker } from '@/components/PriceTicker';
import { NewsFeed } from '@/components/NewsFeed';
import Link from 'next/link';

type Tab = 'all' | 'crypto' | 'football' | 'nba';

const TAB_TO_MTYPE: Partial<Record<Tab, MarketType>> = {
  crypto: MarketType.CRYPTO,
  football: MarketType.FOOTBALL,
  nba: MarketType.BASKETBALL,
};

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'all', label: 'ALL' },
  { key: 'crypto', label: 'CRYPTO' },
  { key: 'football', label: 'FOOTBALL' },
  { key: 'nba', label: 'NBA' },
];

const EMPTY_COPY: Record<Tab, string> = {
  all: 'NO OPEN MARKETS · TAP [ + NEW MARKET ]',
  crypto: 'NO CRYPTO MARKETS OPEN · TAP [ + NEW MARKET ]',
  football: 'NO FOOTBALL MARKETS OPEN · TAP [ + NEW MARKET ]',
  nba: 'NO NBA MARKETS OPEN · TAP [ + NEW MARKET ]',
};

export default function Home() {
  const { markets, isLoading } = useMarkets();
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<Tab>('all');

  // Tick wall-clock so the filter re-evaluates as markets cross closeTime.
  // Without this, a market loaded while still bettable stays visible on the
  // home feed until an unrelated state change forces a re-render — which can
  // be minutes or never. 10s keeps the "MARKET CLOSED" card off the feed
  // quickly after it crosses.
  const [nowSec, setNowSec] = useState(() => BigInt(Math.floor(Date.now() / 1000)));
  useEffect(() => {
    const id = setInterval(() => {
      setNowSec(BigInt(Math.floor(Date.now() / 1000)));
    }, 10_000);
    return () => clearInterval(id);
  }, []);

  // Home feed shows bettable markets only: unresolved, not yet past closeTime,
  // matching the active mType tab, and matching the search filter if set.
  const tabMType = TAB_TO_MTYPE[tab];
  const filteredMarkets = markets.filter((m) => {
    if (m.resolved) return false;
    if (m.closeTime <= nowSec) return false;
    if (tabMType !== undefined && m.mType !== tabMType) return false;
    if (
      search.trim() !== ''
      && !m.question.toLowerCase().includes(search.toLowerCase())
    ) {
      return false;
    }
    return true;
  });

  return (
    <main className="flex-1 flex flex-col w-full bg-transparent min-h-screen pb-12">
      {/* Mobile Top Navigation — hidden on desktop where Sidebar takes over */}
      <header className="flex md:hidden items-stretch border-b border-black mix-blend-multiply bg-transparent sticky top-0 z-50 backdrop-blur-md h-[72px]">
        <div className="aspect-square flex-shrink-0 flex items-center justify-center p-3.5 border-r border-black bg-[var(--color-background)]/80 h-full">
          <div className="bg-black w-full h-full text-[var(--color-background)] flex items-center justify-center font-black text-2xl">
            M
          </div>
        </div>
        <div className="flex-1 flex items-center px-4 md:px-5 border-r border-black bg-[var(--color-background)]/80 h-full">
          <span className="font-black text-3xl tracking-tighter text-foreground uppercase">MAKO</span>
        </div>
        <div className="flex flex-col justify-center items-stretch bg-[var(--color-background)]/80 min-w-[120px] h-full">
          <ConnectButton.Custom>
            {({ account, chain, openAccountModal, openChainModal, openConnectModal, mounted }) => {
              const ready = mounted;
              const connected = ready && account && chain;
              return (
                <div
                  {...(!ready && {
                    'aria-hidden': true,
                    style: { opacity: 0, pointerEvents: 'none', userSelect: 'none' },
                  })}
                  className="flex-1 flex items-stretch h-full"
                >
                  {(() => {
                    if (!connected) {
                      return (
                        <button onClick={openConnectModal} type="button" className="w-full h-full px-4 font-black tracking-widest text-[11px] uppercase hover:bg-black hover:text-[var(--color-background)] transition-colors">
                           [ CONNECT ]
                        </button>
                      );
                    }
                    if (chain.unsupported) {
                      return (
                        <button onClick={openChainModal} type="button" className="w-full h-full px-4 font-black tracking-widest text-[11px] uppercase hover:bg-black hover:text-[var(--color-background)] transition-colors text-warning">
                          WRONG NET
                        </button>
                      );
                    }
                    return (
                      <button onClick={openAccountModal} type="button" className="w-full h-full px-4 font-black tracking-widest text-[11px] uppercase hover:bg-black hover:text-[var(--color-background)] transition-colors">
                        {account.displayName}
                      </button>
                    );
                  })()}
                </div>
              );
            }}
          </ConnectButton.Custom>
        </div>
      </header>

      {/* Mobile Nav Tabs — hidden on desktop */}
      <div className="grid md:hidden grid-cols-2 divide-x divide-black border-b border-black bg-surface">
        <Link
          href="/create"
          className="py-4 px-4 font-black text-[11px] uppercase tracking-widest hover:bg-black hover:text-background transition-colors text-center"
        >
          [ + NEW MARKET ]
        </Link>
        <Link
          href="/me"
          className="py-4 px-4 font-black text-[11px] uppercase tracking-widest hover:bg-black hover:text-background transition-colors text-center"
        >
          [ MY MARKETS ]
        </Link>
      </div>

      <div className="flex flex-col xl:flex-row w-full flex-1 min-h-[calc(100vh-72px)]">
        {/* Main Feed Container */}
        <div className="flex-1 flex flex-col pb-16 min-w-0">
          {/* Search Bar */}
          <div className="w-full border-b border-black bg-[var(--color-background)]">
            <div className="flex items-stretch">
              <div className="flex items-center justify-center px-5 border-r border-black text-muted">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="square">
                  <circle cx="11" cy="11" r="7" />
                  <path d="M21 21l-4.35-4.35" />
                </svg>
              </div>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="SEARCH MARKETS..."
                className="flex-1 py-4 px-5 bg-transparent text-sm font-black uppercase tracking-widest placeholder:text-muted/50 outline-none text-foreground"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="px-5 border-l border-black font-black text-xs uppercase tracking-widest hover:bg-black hover:text-background transition-colors text-muted"
                >
                  CLEAR
                </button>
              )}
            </div>
          </div>

          {/* Market-type tab filter. Sits between the search bar and the
              market list so the user can narrow instantly without scrolling.
              (The price ticker itself is now a fixed-bottom news-channel-style
              crawl rendered at the bottom of this page — see below.) */}
          <div className="grid grid-cols-4 divide-x divide-black border-b border-black">
            {TABS.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={`py-3 font-black text-xs uppercase tracking-widest transition-colors ${
                  tab === key ? 'bg-black text-background' : 'hover:bg-black hover:text-background'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {isLoading && filteredMarkets.length === 0 ? (
            <div className="py-20 text-center font-black uppercase tracking-widest border-b border-black text-muted text-sm bg-surface">
              LOADING LIVE MARKETS…
            </div>
          ) : filteredMarkets.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 w-full bg-transparent">
              {filteredMarkets.map((market, i) => (
                <div
                  key={market.id.toString()}
                  className="w-full border-b border-black md:border-r overflow-hidden bg-[var(--color-background)] animate-in fade-in slide-in-from-bottom-4 duration-500 fill-mode-both"
                  style={{ animationDelay: `${i * 50}ms` }}
                >
                  <Link
                    href={`/market/${market.id.toString()}`}
                    className="w-full h-full block"
                  >
                    <MarketCard market={market} />
                  </Link>
                </div>
              ))}
            </div>
          ) : (
            <div className="py-20 text-center font-black uppercase tracking-widest border-b border-black text-muted text-sm bg-surface px-6">
              {EMPTY_COPY[tab]}
            </div>
          )}
        </div>

        {/* Right Pane: News/Intel Feed — sticky so the main market feed can
            scroll independently on the left. Matches the Sidebar's
            `h-[calc(100dvh-2.25rem)]` (viewport minus the 36px bottom
            ticker) so the three columns (sidebar · feed · intel) all end
            flush with the top of the ticker. Internal overflow-y-auto gives
            the intel list its own scroll track. */}
        <aside className="hidden xl:flex flex-col w-80 2xl:w-96 border-l border-black bg-[var(--color-surface)] shrink-0 sticky top-0 self-start h-[calc(100dvh-2.25rem)] overflow-y-auto">
          <div className="px-6 py-4 border-b border-black sticky top-0 z-40 bg-[var(--color-surface)]">
            <span className="font-black text-xs uppercase tracking-widest text-foreground">MARKET INTEL</span>
          </div>
          <NewsFeed />
        </aside>
      </div>

      {/* News-channel-style bottom crawl. Fixed to the viewport bottom, the
          ticker runs across every breakpoint and doesn't push page content.
          `pb-12` at the outer main keeps the last market card from hiding
          behind the 36px strip. */}
      <PriceTicker />
    </main>
  );
}
