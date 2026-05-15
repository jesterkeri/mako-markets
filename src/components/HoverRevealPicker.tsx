'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';

export function HoverRevealPicker({ className = '' }: { className?: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeKind = pathname === '/create/private' ? 'private' : pathname === '/create' ? 'public' : null;
  const activeKey = activeKind === 'private' ? searchParams.get('shape') : searchParams.get('tab');

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

  const publicChildren = [
    { key: 'crypto', label: 'CRYPTO', href: '/create?tab=crypto', color: 'bg-mako-red text-paper border-ink', tilt: -8 },
    { key: 'football', label: 'FOOTBALL', href: '/create?tab=football', color: 'bg-signal text-ink border-ink', tilt: 4 },
    { key: 'basketball', label: 'NBA', href: '/create?tab=basketball', color: 'bg-ink text-paper border-paper', tilt: 8 },
  ];

  const privateChildren = [
    { key: 'friendly', label: 'FRIENDLY', href: '/create/private?shape=friendly', color: 'bg-mako-red text-paper border-ink', tilt: -8 },
    { key: 'open_vote', label: 'OPEN VOTE', href: '/create/private?shape=open_vote', color: 'bg-signal text-ink border-ink', tilt: 4 },
    { key: 'prize_pool', label: 'PRIZE POOL', href: '/create/private?shape=prize_pool', color: 'bg-ink text-paper border-paper', tilt: 8 },
  ];

  const renderChild = (
    child: { key: string; label: string; href: string; color: string; tilt: number },
    index: number,
    parent: 'public' | 'private'
  ) => {
    const isExpanded = expandedSection === parent;
    const isActive = activeKind === parent && activeKey === child.key;
    
    const isHovered = hoveredChild === child.key;
    const isActivelyHighlighted = isActive || isHovered;

    // Calculate translate offset from parent's center
    const dxFromParent = parent === 'public' 
      ? (index === 0 ? '25%' : index === 1 ? '-50%' : '-125%')
      : (index === 0 ? '125%' : index === 1 ? '50%' : '-25%');
    
    const dyFromParent = '-120%'; 

    // Wrapper handles the macro Mac Genie animation with delay
    const wrapperTransform = isExpanded
      ? `translate(0, 0) scale(1)`
      : `translate(${dxFromParent}, ${dyFromParent}) scale(0.1)`;
      
    const wrapperTransition = 'transform 500ms cubic-bezier(0.34, 1.56, 0.64, 1), opacity 300ms ease';
    const delay = `${index * 80}ms`;

    // Inner Link handles the immediate hover transforms
    const tiltDeg = isActivelyHighlighted ? 0 : child.tilt;
    const scale = isActivelyHighlighted ? 1.05 : 1;
    const translateY = isActivelyHighlighted ? '-4px' : '0px';
    const innerTransform = `translate(0, ${translateY}) scale(${scale}) rotate(${tiltDeg}deg)`;

    return (
      <div
        key={child.key}
        className="flex-1 flex"
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
          className={`flex-1 flex flex-col items-center justify-center font-display font-bold text-xl md:text-3xl py-12 px-4 rounded-3xl text-center border-2 shadow-brutal transition-shadow hover:shadow-brutal-lg ${child.color}`}
          style={{
            transform: innerTransform,
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

  return (
    <div className={`relative flex flex-col items-center ${className}`} onMouseLeave={handleMouseLeave}>
      {/* PARENTS ROW */}
      <div className="w-full max-w-3xl flex flex-col sm:flex-row gap-6 mb-8 relative z-20">
        <button
          type="button"
          onClick={() => toggleSection('public')}
          onMouseEnter={() => handleMouseEnter('public')}
          className={`flex-1 flex flex-col items-center justify-center min-h-[160px] ${publicParentColor} text-ink border-2 border-ink p-6 rounded-3xl shadow-brutal transition-transform hover:-translate-y-1 hover:shadow-brutal-lg`}
          style={{ transform: 'rotate(-4deg)' }}
        >
          <div className="font-display font-bold text-3xl mb-2 text-ink">PUBLIC</div>
          <div className="font-bold text-sm uppercase text-ink">OPEN MARKETS EVERYONE CAN SEE</div>
        </button>

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
      </div>

      {/* CHILDREN TRAY */}
      <div className="w-full max-w-7xl relative z-10 min-h-[100px]">
        {/* PUBLIC CHILDREN */}
        <div 
          className="absolute inset-0 grid grid-cols-1 sm:grid-cols-3 gap-6" 
          style={{ pointerEvents: expandedSection === 'public' ? 'auto' : 'none' }}
        >
          {publicChildren.map((c, i) => renderChild(c, i, 'public'))}
        </div>
        
        {/* PRIVATE CHILDREN */}
        <div 
          className="absolute inset-0 grid grid-cols-1 sm:grid-cols-3 gap-6" 
          style={{ pointerEvents: expandedSection === 'private' ? 'auto' : 'none' }}
        >
          {privateChildren.map((c, i) => renderChild(c, i, 'private'))}
        </div>
      </div>
    </div>
  );
}
