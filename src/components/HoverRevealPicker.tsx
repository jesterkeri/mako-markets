'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';

import { isPmEnabled } from '@/lib/pm-enabled';

// Public side carries 6 publicly-creatable v4 market types
// (CRYPTO / FOOTBALL / NBA / FOREX / COMMODITIES / STOCKS). The 7th
// contract type, MAKO, is admin-curated and does NOT appear on /create
// at all — its create form lives at /admin/create-mako behind the admin
// gate. Private side stays at 3 — those are the fixed PM contract
// shapes (Friendly / Open Vote / Prize Pool).
//
// Rendering split: Public expands into a uniform grid (genie offset
// math doesn't generalize past 3 children cleanly). Private keeps the
// existing genie animation since its child count is stable.
//
// Grid math: 6 children fits cleanly into both the 2-col mobile and
// 4-col sm+ layouts (mobile = 3 rows of 2, sm+ = 1 row of 4 + 1 row
// of 2). No orphan-row fix needed at this count.

type Child = {
  key: string;
  label: string;
  href: string;
  color: string;
  tilt: number;
};

const publicChildren: Child[] = [
  { key: 'crypto',      label: 'CRYPTO',      href: '/create?tab=crypto',      color: 'bg-mako-red text-paper border-ink', tilt: -8 },
  { key: 'football',    label: 'FOOTBALL',    href: '/create?tab=football',    color: 'bg-signal text-ink border-ink',     tilt: 4 },
  { key: 'basketball',  label: 'NBA',         href: '/create?tab=basketball',  color: 'bg-ink text-paper border-paper',    tilt: 8 },
  { key: 'forex',       label: 'FOREX',       href: '/create?tab=forex',       color: 'bg-mako-teal text-ink border-ink',  tilt: -4 },
  { key: 'commodities', label: 'COMMODITIES', href: '/create?tab=commodities', color: 'bg-mako-gold text-ink border-ink',  tilt: 6 },
  { key: 'stocks',      label: 'STOCKS',      href: '/create?tab=stocks',      color: 'bg-paper text-ink border-ink',      tilt: -6 },
];

const privateChildren: Child[] = [
  { key: 'friendly',   label: 'FRIENDLY',   href: '/create/private?shape=friendly',   color: 'bg-mako-red text-paper border-ink', tilt: -8 },
  { key: 'open_vote',  label: 'OPEN VOTE',  href: '/create/private?shape=open_vote',  color: 'bg-signal text-ink border-ink',     tilt: 4 },
  { key: 'prize_pool', label: 'PRIZE POOL', href: '/create/private?shape=prize_pool', color: 'bg-ink text-paper border-paper',    tilt: 8 },
];

export function HoverRevealPicker({ className = '' }: { className?: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeKind = pathname === '/create/private' ? 'private' : pathname === '/create' ? 'public' : null;
  const activeKey = activeKind === 'private' ? searchParams.get('shape') : searchParams.get('tab');

  // #180 PM gate: hide the entire PRIVATE column + tray when
  // NEXT_PUBLIC_PM_ENABLED is off. Public column expands to full
  // width. The flag is a build-time-baked NEXT_PUBLIC_*, so this
  // read is safe on the client and flips with the next Vercel
  // redeploy after env rotation.
  const pmEnabled = isPmEnabled();

  const [expandedSection, setExpandedSection] = useState<'public' | 'private' | null>(null);
  const [hoveredChild, setHoveredChild] = useState<string | null>(null);

  const handleMouseEnter = (section: 'public' | 'private') => {
    setExpandedSection(section);
  };

  const handleMouseLeave = () => {
    setExpandedSection(null);
  };

  const toggleSection = (section: 'public' | 'private') => {
    setExpandedSection(prev => prev === section ? null : section);
  };

  // We are presenting Combo A by default: Teal and Gold
  const publicParentColor = 'bg-mako-teal';
  const privateParentColor = 'bg-mako-gold';

  // Inner-link hover effects shared by both renderers.
  const innerHoverTransform = (child: Child, isActivelyHighlighted: boolean) => {
    const tiltDeg = isActivelyHighlighted ? 0 : child.tilt;
    const scale = isActivelyHighlighted ? 1.05 : 1;
    const translateY = isActivelyHighlighted ? '-4px' : '0px';
    return `translate(0, ${translateY}) scale(${scale}) rotate(${tiltDeg}deg)`;
  };

  // Private-side renderer: Mac Genie animation with 3-position offset math.
  // Locked to 3 children — `dxFromParent` indexes 0/1/2 explicitly.
  const renderPrivateChild = (child: Child, index: number) => {
    const isExpanded = expandedSection === 'private';
    const isActive = activeKind === 'private' && activeKey === child.key;
    const isHovered = hoveredChild === child.key;
    const isActivelyHighlighted = isActive || isHovered;

    const dxFromParent = index === 0 ? '125%' : index === 1 ? '50%' : '-25%';
    const dyFromParent = '-120%';

    const wrapperTransform = isExpanded
      ? `translate(0, 0) scale(1)`
      : `translate(${dxFromParent}, ${dyFromParent}) scale(0.1)`;
    const wrapperTransition = 'transform 500ms cubic-bezier(0.34, 1.56, 0.64, 1), opacity 300ms ease';
    const delay = `${index * 80}ms`;

    return (
      <div
        key={child.key}
        className="flex-1 flex"
        aria-hidden={!isExpanded}
        style={{
          transform: wrapperTransform,
          transition: wrapperTransition,
          transitionDelay: isExpanded ? delay : '0ms',
          opacity: isExpanded ? 1 : 0,
          pointerEvents: isExpanded ? 'auto' : 'none',
          width: '100%',
        }}
      >
        <Link
          href={child.href}
          tabIndex={isExpanded ? 0 : -1}
          className={`flex-1 flex flex-col items-center justify-center font-display font-bold text-xl md:text-3xl py-12 px-4 rounded-3xl text-center border-2 shadow-brutal transition-shadow hover:shadow-brutal-lg ${child.color}`}
          style={{
            transform: innerHoverTransform(child, isActivelyHighlighted),
            transition: 'transform 200ms ease-out',
          }}
          onClick={(e) => {
            if (!isExpanded) e.preventDefault();
          }}
          onMouseEnter={() => setHoveredChild(child.key)}
          onMouseLeave={() => setHoveredChild(null)}
        >
          {child.label}
        </Link>
      </div>
    );
  };

  // Public-side renderer: fixed 6 children. No genie offset; children
  // fade + scale in place inside the grid. Staggered delay preserves
  // the "rolling reveal" feel without the 3-position math.
  const renderPublicChild = (child: Child, index: number) => {
    const isExpanded = expandedSection === 'public';
    const isActive = activeKind === 'public' && activeKey === child.key;
    const isHovered = hoveredChild === child.key;
    const isActivelyHighlighted = isActive || isHovered;

    const wrapperTransform = isExpanded
      ? `translate(0, 0) scale(1)`
      : `translate(0, -20%) scale(0.85)`;
    const wrapperTransition = 'transform 400ms cubic-bezier(0.34, 1.56, 0.64, 1), opacity 250ms ease';
    const delay = `${index * 50}ms`;

    return (
      <div
        key={child.key}
        className="flex"
        aria-hidden={!isExpanded}
        style={{
          transform: wrapperTransform,
          transition: wrapperTransition,
          transitionDelay: isExpanded ? delay : '0ms',
          opacity: isExpanded ? 1 : 0,
          pointerEvents: isExpanded ? 'auto' : 'none',
          width: '100%',
        }}
      >
        <Link
          href={child.href}
          tabIndex={isExpanded ? 0 : -1}
          className={`flex-1 flex flex-col items-center justify-center font-display font-bold text-base md:text-xl lg:text-2xl py-8 px-3 rounded-2xl text-center border-2 shadow-brutal transition-shadow hover:shadow-brutal-lg ${child.color}`}
          style={{
            transform: innerHoverTransform(child, isActivelyHighlighted),
            transition: 'transform 200ms ease-out',
          }}
          onClick={(e) => {
            if (!isExpanded) e.preventDefault();
          }}
          onMouseEnter={() => setHoveredChild(child.key)}
          onMouseLeave={() => setHoveredChild(null)}
        >
          <span>{child.label}</span>
        </Link>
      </div>
    );
  };

  return (
    <div className={`relative flex flex-col items-center ${className}`} onMouseLeave={handleMouseLeave}>
      {/* PARENTS ROW. When PM is disabled (#180), only the PUBLIC
          card renders and stretches to full width. */}
      <div className="w-full max-w-3xl flex flex-col sm:flex-row gap-6 mb-8 relative z-20">
        <button
          type="button"
          onClick={() => toggleSection('public')}
          onMouseEnter={() => handleMouseEnter('public')}
          className={`flex-1 flex flex-col items-center justify-center min-h-[160px] ${publicParentColor} text-ink border-2 border-ink p-6 rounded-3xl shadow-brutal transition-transform hover:-translate-y-1 hover:shadow-brutal-lg`}
          style={{ transform: pmEnabled ? 'rotate(-4deg)' : 'rotate(0deg)' }}
        >
          <div className="font-display font-bold text-3xl mb-2 text-ink">PUBLIC</div>
          <div className="font-bold text-sm uppercase text-ink">OPEN MARKETS EVERYONE CAN SEE</div>
        </button>

        {pmEnabled && (
          <button
            type="button"
            onClick={() => toggleSection('private')}
            onMouseEnter={() => handleMouseEnter('private')}
            className={`flex-1 flex flex-col items-center justify-center min-h-[160px] ${privateParentColor} text-ink border-2 border-ink p-6 rounded-3xl shadow-brutal transition-transform hover:-translate-y-1 hover:shadow-brutal-lg`}
            style={{ transform: 'rotate(4deg)' }}
          >
            <div className="font-display font-bold text-3xl mb-2 text-ink">PRIVATE</div>
            <div className="font-bold text-sm uppercase text-ink">CUSTOM FOR YOUR COMMUNITY</div>
          </button>
        )}
      </div>

      {/* CHILDREN TRAY
          Public has 6 children: 4-col grid on sm+ (rows of 4 + 2),
          2-col on mobile (3 rows of 2 — even, no orphan). Private keeps
          the 3-col tray aligned with its 3 fixed shapes. Both trays
          absolutely position inside the same container so only one is
          visible at a time; the container must reserve enough height
          for the larger tray (Public). Without this min-h, absolute
          children don't expand the parent and Public's mobile layout
          overflows into the form below. Private tray omitted when
          PM gate is off (#180). */}
      <div className="w-full max-w-7xl relative z-10 min-h-[380px] sm:min-h-[260px]">
        {/* PUBLIC CHILDREN — 6 tiles. */}
        <div
          className="absolute inset-0 grid grid-cols-2 sm:grid-cols-4 gap-4 md:gap-6"
          style={{ pointerEvents: expandedSection === 'public' ? 'auto' : 'none' }}
        >
          {publicChildren.map((c, i) => renderPublicChild(c, i))}
        </div>

        {/* PRIVATE CHILDREN — 3 tiles, genie animation. Omitted when
            PM gate is off so the tray height/pointer-events don't
            shadow the public column. */}
        {pmEnabled && (
          <div
            className="absolute inset-0 grid grid-cols-1 sm:grid-cols-3 gap-6"
            style={{ pointerEvents: expandedSection === 'private' ? 'auto' : 'none' }}
          >
            {privateChildren.map((c, i) => renderPrivateChild(c, i))}
          </div>
        )}
      </div>
    </div>
  );
}
