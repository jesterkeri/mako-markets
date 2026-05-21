'use client';

import Link from 'next/link';

/**
 * One-line tab row rendered at the top of every /admin/* page.
 *
 * Renders as plain links (not a router tab strip) so each page still
 * does its own auth gate + data fetch. Active tab = ink fill + paper
 * text + red-offset shadow (matches the home feed's colorful pill
 * treatment).
 */

type AdminSection = 'overview' | 'users' | 'markets' | 'activity' | 'resolve' | 'create-mako';

const TABS: Array<{ key: AdminSection; label: string; href: string }> = [
  { key: 'overview', label: 'OVERVIEW', href: '/admin' },
  { key: 'users', label: 'USERS', href: '/admin/users' },
  { key: 'markets', label: 'MARKETS', href: '/admin/markets' },
  { key: 'activity', label: 'ACTIVITY', href: '/admin/activity' },
  { key: 'resolve', label: 'RESOLVE', href: '/admin/resolve' },
  { key: 'create-mako', label: 'CREATE MAKO', href: '/admin/create-mako' },
];

export function AdminNav({ active }: { active: AdminSection }) {
  return (
    <div className="px-4 sm:px-6 lg:px-8 py-4 border-b-2 border-ink">
      <nav className="flex items-center gap-3 overflow-x-auto pb-1">
        {TABS.map((tab) => {
          const isActive = tab.key === active;
          return (
            <Link
              key={tab.key}
              href={tab.href}
              aria-current={isActive ? 'page' : undefined}
              className={`
                mako-label px-4 py-2 rounded-full border-2 border-ink transition-all whitespace-nowrap
                ${isActive
                  ? 'bg-ink text-paper shadow-[4px_4px_0_0_#D94A3D] -translate-y-[2px] -translate-x-[2px]'
                  : 'bg-paper text-ink shadow-brutal-sm hover:shadow-brutal hover:-translate-y-[1px] hover:-translate-x-[1px]'}
              `}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
