'use client';

import Link from 'next/link';

import { Logo } from '@/components/Logo';
import { MobileMenu } from '@/components/MobileMenu';
import { ThemeToggle } from '@/components/ThemeToggle';

// ---------------------------------------------------------------------------
// MobileChromeHeader
//
// The shared mobile chrome bar shown across home / /me / /profile / /create.
// Mirrors the desktop sticky header (`hidden md:flex` on each page) — same
// h-12-ish chrome surface, same brand/divider treatment — so navigating
// between pages on mobile feels continuous instead of each page inventing
// its own header.
//
// Layout: Logo + MAKO wordmark on the left (links home), ThemeToggle +
// hamburger MobileMenu on the right. ThemeToggle is intentionally outside
// the drawer (one-tap light/dark flip) per Joshua's mobile review.
// ---------------------------------------------------------------------------

export function MobileChromeHeader() {
  // z-[60] keeps the header (and the MobileMenu drawer rendered
  // inside it) above the fixed-bottom BetSheet wrapper (z-50).
  // Sticky position creates a stacking context, so the drawer's
  // own z-[60] is bounded by this parent value — bumping the
  // parent is what lets the drawer cover the BetSheet when open.
  return (
    <header className="md:hidden flex items-center justify-between px-4 py-3 bg-chrome text-chrome-fg border-b-2 border-chrome-divider sticky top-0 z-[60]">
      <Link href="/" className="flex items-center gap-2">
        <Logo size={28} className="text-chrome-fg" title="Mako Market" />
        <span className="font-display font-black text-2xl tracking-tight text-chrome-fg">
          MAKO MARKET
        </span>
      </Link>
      <div className="flex items-center gap-2">
        <ThemeToggle />
        <MobileMenu />
      </div>
    </header>
  );
}
