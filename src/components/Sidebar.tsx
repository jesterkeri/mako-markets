'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion, AnimatePresence } from 'motion/react';
import { useState } from 'react';
import { useAccount } from 'wagmi';
import { AvatarCircle } from '@/components/AvatarCircle';
import { Logo } from '@/components/Logo';
import { useUser } from '@/lib/use-user';
import { getDisplayName, getIdentityLabel } from '@/lib/user-display';

/**
 * Neobrutalist hover-expand sidebar.
 *
 * Default: 80px icon rail. Hover anywhere on the aside to spring out to
 * 288px; mouse-leave collapses back. Auth UI deliberately lives in the
 * page top header, not here — Joshua redirected during Phase 1F visual
 * review because the sidebar bottom auth panel made the surface feel
 * heavy. The sidebar is now a pure nav element.
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

/**
 * Bottom-of-sidebar account block. Renders only for authed users —
 * either Magic-session OR connected wallet. Links to /profile.
 *
 * Phase 1E added wallet auth recognition. Before 1E this only checked
 * `useUser()`, leaving wallet-only users without a sidebar identity
 * affordance — same gap that hid the SIGN OUT button on the home
 * header.
 */
function SidebarAccount({ hovering }: { hovering: boolean }) {
  const { user } = useUser();
  const { address: connectedWallet } = useAccount();

  if (!user && !connectedWallet) return null;

  // Identity label: Magic email or wallet address (per AuthedUser
  // discriminator), or formatted connected-wallet address when signed
  // in solely via wagmi.
  const label = user
    ? getIdentityLabel(user)
    : `${connectedWallet!.slice(0, 6)}…${connectedWallet!.slice(-4)}`;
  const initial = user
    ? getDisplayName(user).trim().charAt(0).toUpperCase() || '?'
    : '0x';
  // AvatarCircle prop fan-out per authType.
  const avatarInitialSource = user
    ? user.authType === 'magic' ? user.email : user.walletAddress
    : '';
  const avatarSeedKey = user
    ? user.authType === 'magic' ? user.magicEoa : user.walletAddress
    : '';

  return (
    <div className="mt-auto border-t-2 border-chrome-divider shrink-0">
      {hovering ? (
        <Link href="/profile" className="flex flex-col gap-2 p-4 hover:bg-chrome-fg/10 transition-colors">
          <div
            className="mako-label text-[10px] text-muted truncate"
            title={label}
          >
            {label}
          </div>
          <div className="mako-button mako-label w-full px-3! py-1.5! text-[11px]! text-center">
            PROFILE
          </div>
        </Link>
      ) : (
        <Link
          href="/profile"
          className="flex items-center justify-center py-3 hover:bg-chrome-fg/10 transition-colors block"
          aria-label={`Signed in as ${label}`}
          title={label}
        >
          {user ? (
            <AvatarCircle
              displayName={user.displayName}
              initialSource={avatarInitialSource}
              seedKey={avatarSeedKey}
              avatarUrl={user.avatarUrl}
              size={36}
              className="mx-auto"
            />
          ) : (
            <div
              className="flex items-center justify-center w-9 h-9 rounded-full border-2 border-chrome-divider bg-signal text-ink font-display font-black text-sm mx-auto"
            >
              {initial}
            </div>
          )}
        </Link>
      )}
    </div>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const [hovering, setHovering] = useState(false);

  return (
    <div 
      className="hidden md:block shrink-0 sticky top-0 self-start w-[80px] h-[calc(100dvh-var(--ticker-safe-area,2.5rem))] z-50"
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <motion.aside
        initial={false}
        animate={{ width: hovering ? EXPANDED_WIDTH : COLLAPSED_WIDTH }}
        transition={{ type: 'spring', stiffness: 300, damping: 32 }}
        className="absolute left-0 top-0 h-full flex flex-col border-r-2 border-chrome-divider bg-chrome overflow-y-auto overflow-x-hidden no-scrollbar shadow-[4px_0_24px_rgba(0,0,0,0.15)]"
      >
      {/* Brand row — centered when collapsed (matches the icon-only nav rail
          beneath it); shifts to a left-aligned logo + wordmark when expanded. */}
      <Link
        href="/"
        className={`flex items-center h-12 border-b-2 border-chrome-divider shrink-0 hover:bg-chrome-fg/10 transition-colors min-w-0 ${
          hovering ? 'justify-start gap-3 px-5' : 'justify-center px-0'
        }`}
      >
        <Logo size={22} className="text-chrome-fg shrink-0" title="Mako Market" />
        <AnimatePresence initial={false}>
          {hovering && (
            <motion.span
              key="wordmark"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="font-display font-black text-base tracking-tight leading-none text-chrome-fg whitespace-nowrap"
            >
              MAKO MARKET
            </motion.span>
          )}
        </AnimatePresence>
      </Link>

      {/* Nav. Wrapped in flex-1 so SidebarAccount's mt-auto pins it to the
          bottom whenever an authed account block is rendered; unauthed users
          just see nav with empty space below. */}
      <nav className="p-4 flex flex-col gap-1 flex-1">
        {items.map((item) => {
          const isActive = pathname === item.path;
          const activeClass = isActive
            ? 'border-chrome-fg bg-chrome-fg text-chrome'
            : 'border-transparent text-chrome-fg hover:border-chrome-divider hover:bg-chrome-fg/10';
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
                    className="font-display font-black text-[clamp(1.125rem,2vw,1.25rem)] tracking-tight leading-none whitespace-nowrap"
                  >
                    {item.label}
                  </motion.span>
                )}
              </AnimatePresence>
            </Link>
          );
        })}
      </nav>

      <SidebarAccount hovering={hovering} />
      </motion.aside>
    </div>
  );
}
