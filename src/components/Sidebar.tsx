'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { motion, AnimatePresence } from 'motion/react';
import { useState } from 'react';
import { Logo } from '@/components/Logo';

/**
 * Neobrutalist hover-expand sidebar.
 *
 * Default state is an 80px icon rail. Hovering the sidebar expands it to
 * 288px with a spring animation; mouse-leave collapses it back. No toggle
 * button — the interaction is pure hover. Icons stay visible in both
 * states so the rail is always legible; the wordmark + labels fade in
 * under AnimatePresence when expanded.
 */

const EXPANDED_WIDTH = 288;
const COLLAPSED_WIDTH = 80;

type NavItem = {
  label: string;
  path: string;
  icon: React.ReactNode;
};

const STROKE = {
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  fill: 'none',
};

function MarketsIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" {...STROKE}>
      <path d="M3 20V10M9 20V4M15 20V13M21 20V7" />
    </svg>
  );
}

function PortfolioIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" {...STROKE}>
      <path d="M3 7h18v12H3z" />
      <path d="M16 12h2" />
      <path d="M7 7V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function CreateIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" {...STROKE}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

const items: NavItem[] = [
  { label: 'Markets', path: '/', icon: <MarketsIcon /> },
  { label: 'Portfolio', path: '/me', icon: <PortfolioIcon /> },
  { label: 'Create', path: '/create', icon: <CreateIcon /> },
];

export function Sidebar() {
  const pathname = usePathname();
  const [hovering, setHovering] = useState(false);

  return (
    <motion.aside
      initial={false}
      animate={{ width: hovering ? EXPANDED_WIDTH : COLLAPSED_WIDTH }}
      transition={{ type: 'spring', stiffness: 300, damping: 32 }}
      onHoverStart={() => setHovering(true)}
      onHoverEnd={() => setHovering(false)}
      className="hidden md:flex flex-col shrink-0 border-r-2 border-ink bg-paper sticky top-0 self-start h-[calc(100dvh-2.25rem)] overflow-y-auto overflow-x-hidden no-scrollbar z-40"
    >
      {/* Brand row */}
      <Link
        href="/"
        className="flex items-center gap-3 h-20 border-b-2 border-ink shrink-0 px-5 hover:bg-surface-elevated transition-colors min-w-0"
      >
        <Logo size={32} className="text-ink shrink-0" title="Mako Markets" />
        <AnimatePresence initial={false}>
          {hovering && (
            <motion.span
              key="wordmark"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="font-display font-black text-2xl tracking-tight leading-none text-ink whitespace-nowrap"
            >
              MAKO
            </motion.span>
          )}
        </AnimatePresence>
      </Link>

      {/* Nav */}
      <nav className="p-4 flex flex-col gap-1">
        {items.map((item) => {
          const isActive = pathname === item.path;
          // Red inset stripe is an expanded-only accent — it looks awkward on
          // a square icon tile. When collapsed, active just gets the ink fill.
          const activeClass = isActive
            ? hovering
              ? 'border-ink bg-ink text-paper shadow-[inset_4px_0_0_0_#D94A3D]'
              : 'border-ink bg-ink text-paper'
            : 'border-transparent text-ink hover:border-ink hover:bg-surface-elevated';
          return (
            <Link
              key={item.path}
              href={item.path}
              aria-current={isActive ? 'page' : undefined}
              aria-label={item.label}
              className={`flex items-center h-12 rounded-xl border-2 transition-colors min-w-0 overflow-hidden ${
                hovering ? 'gap-3 px-3 justify-start' : 'justify-center px-0'
              } ${activeClass}`}
            >
              <span className="shrink-0 flex items-center justify-center w-6 h-6">
                {item.icon}
              </span>
              <AnimatePresence initial={false}>
                {hovering && (
                  <motion.span
                    key={`label-${item.path}`}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    className="font-display font-black text-lg tracking-tight leading-none whitespace-nowrap"
                  >
                    {item.label}
                  </motion.span>
                )}
              </AnimatePresence>
            </Link>
          );
        })}
      </nav>

      {/* Wallet — fades in only when expanded (icon rail has no room for a full button) */}
      <div className="mt-auto border-t-2 border-ink bg-surface-elevated">
        <AnimatePresence initial={false}>
          {hovering && (
            <motion.div
              key="wallet"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
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
                      className="flex flex-col gap-1 p-4"
                    >
                      {!connected && (
                        <button
                          onClick={openConnectModal}
                          type="button"
                          className="mako-button mako-button--signal w-full mako-label text-ink"
                        >
                          CONNECT WALLET
                        </button>
                      )}
                      {connected && chain.unsupported && (
                        <button
                          onClick={openChainModal}
                          type="button"
                          className="mako-button mako-button--action w-full mako-label"
                        >
                          WRONG NETWORK
                        </button>
                      )}
                      {connected && !chain.unsupported && (
                        <>
                          <button
                            onClick={openChainModal}
                            type="button"
                            className="mako-button w-full mako-label justify-start"
                          >
                            {chain.hasIcon && chain.iconUrl && (
                              <img
                                alt={chain.name ?? 'Chain icon'}
                                src={chain.iconUrl}
                                style={{ width: 14, height: 14, borderRadius: 999 }}
                              />
                            )}
                            <span className="truncate">{chain.name}</span>
                          </button>
                          <button
                            onClick={openAccountModal}
                            type="button"
                            className="mako-button w-full mako-label truncate"
                          >
                            {account.displayName}
                          </button>
                        </>
                      )}
                    </div>
                  );
                }}
              </ConnectButton.Custom>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.aside>
  );
}
