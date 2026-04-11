'use client';

import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useMarkets } from '@/lib/hooks';
import { MarketType } from '@/lib/contract';
import { MarketCard } from '@/components/MarketCard';
import Link from 'next/link';

export default function Home() {
  const { markets, isLoading } = useMarkets();

  // Home feed shows BETTABLE structured markets only.
  // - Exclude concluded markets (past closeTime or already resolved) to keep
  //   discovery focused on what users can still bet on.
  // - Exclude ADHOC markets entirely — retired from the product surface
  //   because they can't be auto-resolved. Existing ADHOC markets remain
  //   accessible via direct `/market/[id]` URLs but aren't discoverable here.
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const filteredMarkets = markets.filter(
    (m) =>
      !m.resolved &&
      m.closeTime > nowSec &&
      m.mType !== MarketType.ADHOC,
  );

  return (
    <>
      <header className="flex items-stretch border-b border-black mix-blend-multiply bg-transparent sticky top-0 z-50 backdrop-blur-md h-[72px]">
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

      {/* Nav row: create new market / view my positions */}
      <div className="grid grid-cols-2 divide-x divide-black border-b border-black">
        <Link
          href="/create"
          className="py-4 px-4 font-black text-xs uppercase tracking-widest hover:bg-black hover:text-background transition-colors text-center"
        >
          [ + NEW MARKET ]
        </Link>
        <Link
          href="/me"
          className="py-4 px-4 font-black text-xs uppercase tracking-widest hover:bg-black hover:text-background transition-colors text-center"
        >
          [ MY MARKETS ]
        </Link>
      </div>

      <div className="flex flex-col w-full pb-8">
        {isLoading && filteredMarkets.length === 0 ? (
          <div className="py-20 text-center font-black uppercase tracking-widest border-b border-black text-muted text-sm">
            LOADING LIVE MARKETS…
          </div>
        ) : filteredMarkets.length > 0 ? (
          filteredMarkets.map((market) => (
            <Link
              key={market.id.toString()}
              href={`/market/${market.id.toString()}`}
              className="w-full block"
            >
              <MarketCard market={market} />
            </Link>
          ))
        ) : (
          <div className="py-20 text-center font-black uppercase tracking-widest border-b border-black text-muted text-sm">
            NO MARKETS ACTIVE
          </div>
        )}
      </div>
    </>
  );
}
