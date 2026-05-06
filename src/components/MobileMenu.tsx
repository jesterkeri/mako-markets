'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useAccount, useDisconnect } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';

import { AvatarCircle } from '@/components/AvatarCircle';
import { Logo } from '@/components/Logo';
import { useUser, USER_QUERY_KEY } from '@/lib/use-user';
import { getDisplayName, getIdentityLabel } from '@/lib/user-display';

// ---------------------------------------------------------------------------
// MobileMenu
//
// The mobile counterpart to the desktop hover-expand Sidebar. Replaces the
// previous MobileHeader SIGN OUT button + the empty-square MobileBottomNav.
// One hamburger button in the top-right of the mobile chrome opens a
// right-side drawer with the rest of the sidebar surfaces:
//   - Brand row (Logo + MAKO wordmark)
//   - Nav (Markets / Portfolio / Create) with proper icons (Sidebar parity)
//   - Account block (Magic email or truncated wallet → /profile link)
//   - SIGN IN (unauthed) / SIGN OUT (authed)
//
// ThemeToggle deliberately stays in the page's mobile chrome bar (where
// it always was), not in the drawer — one tap to flip light/dark without
// opening the menu.
//
// Sign-out logic mirrors AuthMenu: clear Magic session if `user`, wagmi
// disconnect if `connectedWallet`. Mixed-state runs both. On Magic logout
// failure (throw or non-OK) the drawer surfaces an error and does NOT
// touch wagmi (same bail policy as /profile sub-F round-2 fix).
// ---------------------------------------------------------------------------

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

function HamburgerIcon() {
  // mdi_hamburger from Material Design Icons. Literal hamburger food icon
  // chosen by Joshua as the menu trigger — the visual pun is the point.
  // Original SVG was hard-coded `fill="white"`; switched to currentColor so
  // it adapts to the chrome surface.
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M22 13C22 14.11 21.11 15 20 15H4C3.46957 15 2.96086 14.7893 2.58579 14.4142C2.21071 14.0391 2 13.5304 2 13C2 12.4696 2.21071 11.9609 2.58579 11.5858C2.96086 11.2107 3.46957 11 4 11H13L15.5 13L18 11H20C20.5304 11 21.0391 11.2107 21.4142 11.5858C21.7893 11.9609 22 12.4696 22 13ZM12 3C3 3 3 9 3 9H21C21 9 21 3 12 3ZM3 18C3 19.66 4.34 21 6 21H18C19.66 21 21 19.66 21 18V17H3V18Z"
        fill="currentColor"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
      <path d="M6 6L18 18M18 6L6 18" />
    </svg>
  );
}

type NavItem = {
  label: string;
  path: string;
  icon: React.ReactNode;
};

const NAV_ITEMS: NavItem[] = [
  { label: 'Markets', path: '/', icon: <MarketsIcon /> },
  { label: 'Portfolio', path: '/me', icon: <PortfolioIcon /> },
  { label: 'Create', path: '/create', icon: <CreateIcon /> },
];

export function MobileMenu({ className }: { className?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const { user, isLoading: isUserLoading } = useUser();
  const { address: connectedWallet } = useAccount();
  const { disconnect } = useDisconnect();

  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  // Lock body scroll while the drawer is open so the feed beneath doesn't
  // continue scrolling under the user's finger.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Escape closes the drawer.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const isAuthed = !!user || !!connectedWallet;
  const identity = user
    ? getIdentityLabel(user)
    : connectedWallet
      ? `${connectedWallet.slice(0, 6)}…${connectedWallet.slice(-4)}`
      : '';
  const initial = user
    ? getDisplayName(user).trim().charAt(0).toUpperCase() || '?'
    : connectedWallet
      ? '0x'
      : '';

  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    setSignOutError(null);
    try {
      if (user) {
        let res: Response;
        try {
          res = await fetch('/api/user/logout', {
            method: 'POST',
            credentials: 'same-origin',
          });
        } catch {
          setSignOutError('Network error during sign-out. Please retry.');
          return;
        }
        if (!res.ok) {
          setSignOutError('Sign-out failed. Please retry.');
          return;
        }
        queryClient.setQueryData(USER_QUERY_KEY, { authed: false });
      }
      if (connectedWallet) {
        try {
          disconnect();
        } catch (e) {
          console.warn('Wallet disconnect during sign-out failed', e);
        }
      }
      setOpen(false);
      router.push('/');
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open menu"
        aria-expanded={open}
        className={`flex items-center justify-center w-10 h-10 rounded-xl border-2 border-chrome-divider text-chrome-fg hover:bg-chrome-fg/10 transition-colors ${className ?? ''}`}
      >
        <HamburgerIcon />
      </button>

      <AnimatePresence>
        {open && (
          <>
            <motion.div
              key="backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={() => setOpen(false)}
              className="fixed inset-0 z-[60] bg-ink/60 md:hidden"
              aria-hidden="true"
            />
            <motion.aside
              key="drawer"
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', stiffness: 320, damping: 36 }}
              className="fixed top-0 right-0 z-[60] h-dvh w-[85%] max-w-sm bg-chrome text-chrome-fg border-l-2 border-chrome-divider flex flex-col md:hidden"
              role="dialog"
              aria-modal="true"
              aria-label="Mobile navigation"
            >
              {/* Brand row mirrors Sidebar's expanded h-12 brand row */}
              <div className="flex items-center justify-between h-12 px-4 border-b-2 border-chrome-divider shrink-0">
                <Link
                  href="/"
                  onClick={() => setOpen(false)}
                  className="flex items-center gap-2 hover:opacity-80 transition-opacity"
                >
                  <Logo size={22} className="text-chrome-fg" title="Mako Market" />
                  <span className="font-display font-black text-base tracking-tight text-chrome-fg">
                    MAKO MARKET
                  </span>
                </Link>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close menu"
                  className="flex items-center justify-center w-9 h-9 rounded-lg border-2 border-chrome-divider hover:bg-chrome-fg/10 transition-colors"
                >
                  <CloseIcon />
                </button>
              </div>

              {/* Nav */}
              <nav className="p-4 flex flex-col gap-1">
                {NAV_ITEMS.map((item) => {
                  const isActive = pathname === item.path;
                  const activeClass = isActive
                    ? 'border-chrome-fg bg-chrome-fg text-chrome shadow-[inset_4px_0_0_0_#D94A3D]'
                    : 'border-transparent text-chrome-fg hover:border-chrome-divider hover:bg-chrome-fg/10';
                  return (
                    <Link
                      key={item.path}
                      href={item.path}
                      onClick={() => setOpen(false)}
                      aria-current={isActive ? 'page' : undefined}
                      className={`flex items-center gap-3 h-12 px-3 rounded-xl border-2 transition-colors ${activeClass}`}
                    >
                      <span className="shrink-0 flex items-center justify-center w-6 h-6">
                        {item.icon}
                      </span>
                      <span className="font-display font-black text-lg tracking-tight">
                        {item.label}
                      </span>
                    </Link>
                  );
                })}
              </nav>

              {/* Account block — pinned to the bottom. Mirrors Sidebar
                  expanded-state account section. Loading state is a
                  thin skeleton so the drawer doesn't flash an empty
                  bottom on cold open for already-authed users. */}
              {/* Footer block: account row + SIGN OUT (or SIGN IN).
                  `pb-[var(--ticker-safe-area)]` reserves space for the
                  fixed-bottom PriceTicker so SIGN OUT can't be clipped
                  by the crawl strip on mobile. Same token as
                  layout.tsx. */}
              <div className="mt-auto border-t-2 border-chrome-divider shrink-0 pb-[var(--ticker-safe-area)]">
                {isUserLoading && !isAuthed ? (
                  <div className="p-4">
                    <div className="mako-skeleton h-10 w-full" aria-hidden="true" />
                  </div>
                ) : isAuthed ? (
                  <div className="flex flex-col gap-3 p-4">
                    <Link
                      href="/profile"
                      onClick={() => setOpen(false)}
                      className="flex items-center gap-3 hover:opacity-80 transition-opacity"
                    >
                      {user ? (
                        <AvatarCircle
                          displayName={user.displayName}
                          initialSource={user.authType === 'magic' ? user.email : user.walletAddress}
                          seedKey={user.authType === 'magic' ? user.magicEoa : user.walletAddress}
                          avatarUrl={user.avatarUrl}
                          size={36}
                          className="shrink-0"
                        />
                      ) : (
                        <div
                          className="flex items-center justify-center w-9 h-9 rounded-full border-2 border-chrome-divider bg-signal text-ink font-display font-black text-sm shrink-0"
                          aria-hidden="true"
                        >
                          {initial}
                        </div>
                      )}
                      <div className="flex flex-col min-w-0">
                        <span
                          className="mako-label text-[10px] text-muted truncate"
                          title={identity}
                        >
                          {user ? getDisplayName(user) : identity}
                        </span>
                        <span className="mako-label text-[11px] text-chrome-fg">
                          PROFILE
                        </span>
                      </div>
                    </Link>
                    <button
                      type="button"
                      onClick={handleSignOut}
                      disabled={signingOut}
                      className="mako-button mako-label w-full text-center disabled:opacity-60"
                    >
                      {signingOut ? 'SIGNING OUT…' : 'SIGN OUT'}
                    </button>
                    {signOutError && (
                      <p
                        role="alert"
                        className="font-mono text-xs text-mako-red text-center"
                      >
                        {signOutError}
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="p-4">
                    <Link
                      href="/signup"
                      onClick={() => setOpen(false)}
                      className="mako-button mako-button--signal mako-label w-full text-center text-ink block"
                    >
                      SIGN IN
                    </Link>
                  </div>
                )}
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
