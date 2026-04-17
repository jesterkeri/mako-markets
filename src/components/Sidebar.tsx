'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ConnectButton } from '@rainbow-me/rainbowkit';

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden md:flex flex-col w-64 lg:w-72 xl:w-80 border-r border-black shrink-0 sticky top-0 h-[calc(100dvh-2.25rem)] bg-[var(--color-background)] z-50">
      {/* Brand */}
      <Link href="/" className="flex items-center gap-4 px-6 lg:px-8 py-5 border-b border-black group transition-colors">
        <div className="bg-black text-[var(--color-background)] w-10 h-10 flex items-center justify-center font-black text-2xl group-hover:bg-transparent group-hover:text-black border-2 border-transparent group-hover:border-black transition-colors">
          M
        </div>
        <span className="font-black text-3xl tracking-tighter uppercase group-hover:tracking-wider transition-all">MAKO</span>
      </Link>

      {/* Navigation */}
      <nav className="flex flex-col divide-y divide-black border-b border-black">
        <Link 
          href="/" 
          className={`py-5 px-6 lg:px-8 font-black text-sm uppercase tracking-widest transition-colors ${pathname === '/' ? 'bg-black text-background shadow-[inset_4px_0_0_0_#D94A3D]' : 'hover:bg-black hover:text-[var(--color-background)]'}`}
        >
          [ FEED ]
        </Link>
        <Link 
          href="/me" 
          className={`py-5 px-6 lg:px-8 font-black text-sm uppercase tracking-widest transition-colors ${pathname === '/me' ? 'bg-black text-background shadow-[inset_4px_0_0_0_#D94A3D]' : 'hover:bg-black hover:text-[var(--color-background)]'}`}
        >
          [ MY MARKETS ]
        </Link>
        <Link 
          href="/create" 
          className={`py-5 px-6 lg:px-8 font-black text-sm uppercase tracking-widest transition-colors ${pathname === '/create' ? 'bg-black text-background shadow-[inset_4px_0_0_0_#D94A3D]' : 'hover:bg-black hover:text-[var(--color-background)] text-warning bg-warning/5'}`}
        >
          [ + NEW MARKET ]
        </Link>
      </nav>

      {/* Wallet Connection */}
      <div className="mt-auto h-[72px] border-t border-black bg-[var(--color-surface)]">
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
                      <button onClick={openConnectModal} type="button" className="w-full h-full px-4 font-black tracking-widest text-xs uppercase hover:bg-black hover:text-[var(--color-background)] transition-colors">
                         [ CONNECT WALLET ]
                      </button>
                    );
                  }
                  if (chain.unsupported) {
                    return (
                      <button onClick={openChainModal} type="button" className="w-full h-full px-4 font-black tracking-widest text-xs uppercase hover:bg-black hover:text-[var(--color-background)] transition-colors text-warning">
                        WRONG NETWORK
                      </button>
                    );
                  }
                  return (
                    <div className="flex w-full divide-x divide-black h-full">
                      <button
                        onClick={openChainModal}
                        style={{ display: 'flex', alignItems: 'center' }}
                        type="button"
                        className="px-4 font-black text-xs hover:bg-black hover:text-[var(--color-background)] transition-colors justify-center whitespace-nowrap"
                      >
                        {chain.hasIcon && (
                          <div
                            style={{ background: chain.iconBackground, width: 14, height: 14, borderRadius: 999, overflow: 'hidden', marginRight: 4 }}
                          >
                            {chain.iconUrl && (
                              <img alt={chain.name ?? 'Chain icon'} src={chain.iconUrl} style={{ width: 14, height: 14 }} />
                            )}
                          </div>
                        )}
                        {chain.name}
                      </button>
                      <button onClick={openAccountModal} type="button" className="flex-1 px-4 font-black text-sm uppercase tracking-widest hover:bg-black hover:text-[var(--color-background)] transition-colors truncate text-center">
                         {account.displayName}
                      </button>
                    </div>
                  );
                })()}
              </div>
            );
          }}
        </ConnectButton.Custom>
      </div>
    </aside>
  );
}
