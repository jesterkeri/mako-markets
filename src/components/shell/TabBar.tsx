'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { activeNav, NAV } from '@/lib/shell-nav';
import { tabBarHidden, useTourStep } from '@/lib/tour';

import { TAB_ICON } from './icons';

/// The mobile bottom tab bar (2a): a floating pill with the four destinations; a yellow indicator slides under
/// the active one and fades out on pages that are not a tab.
export function TabBar() {
  const active = activeNav(usePathname() ?? '/');
  const index = NAV.findIndex((n) => n.key === active);
  const tourStep = useTourStep();
  // How to play hides the bar on its Home and Create steps, as the design draws them.
  if (tabBarHidden(tourStep)) return null;
  return (
    <>
      <div
        aria-hidden="true"
        style={{ position: 'fixed', left: 0, right: 0, bottom: 0, height: 120, zIndex: 40, pointerEvents: 'none', background: 'linear-gradient(to top, color-mix(in srgb, var(--mako-canvas) 78%, transparent), transparent)' }}
      />
      <nav
        aria-label="Main"
        style={{
          position: 'fixed',
          left: 22,
          right: 22,
          bottom: 'calc(18px + env(safe-area-inset-bottom))',
          zIndex: 41,
          height: 60,
          borderRadius: 9999,
          padding: 5,
          background: 'var(--tb-bg)',
          boxShadow: 'var(--tb-sh)',
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
        }}
      >
        <span
          className="mk-tabind"
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: 5,
            bottom: 5,
            left: 5,
            width: 'calc((100% - 10px) / 4)',
            borderRadius: 9999,
            background: 'var(--mako-signal)',
            boxShadow: 'inset 0 0 0 1.5px #000, 0 3px 8px rgba(0,0,0,0.18)',
            transform: `translateX(${Math.max(0, index) * 100}%)`,
            opacity: index >= 0 ? 1 : 0,
          }}
        />
        {NAV.map((n, i) => (
          <Link
            key={n.key}
            href={n.href}
            aria-label={n.label}
            aria-current={i === index ? 'page' : undefined}
            className="mk-tab"
            style={{ position: 'relative', borderRadius: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', color: i === index ? '#000' : 'var(--tb-fg)' }}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path fillRule="evenodd" clipRule="evenodd" d={TAB_ICON[n.key]} />
            </svg>
          </Link>
        ))}
      </nav>
    </>
  );
}
