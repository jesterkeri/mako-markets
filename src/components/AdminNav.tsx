'use client';

import Link from 'next/link';

/**
 * One-line tab row rendered at the top of every /admin/* page.
 *
 * Renders as plain links (not a router tab strip) so each page still
 * does its own auth gate + data fetch. Active tab is black-on-background,
 * inactive is transparent with a border on hover.
 */

type AdminSection = 'overview' | 'users' | 'markets' | 'activity' | 'resolve';

const TABS: Array<{ key: AdminSection; label: string; href: string }> = [
  { key: 'overview', label: 'OVERVIEW', href: '/admin' },
  { key: 'users', label: 'USERS', href: '/admin/users' },
  { key: 'markets', label: 'MARKETS', href: '/admin/markets' },
  { key: 'activity', label: 'ACTIVITY', href: '/admin/activity' },
  { key: 'resolve', label: 'RESOLVE', href: '/admin/resolve' },
];

export function AdminNav({ active }: { active: AdminSection }) {
  return (
    <div className="border-b border-black overflow-x-auto">
      <nav className="flex items-stretch divide-x divide-black min-w-max">
        {TABS.map((tab) => {
          const isActive = tab.key === active;
          return (
            <Link
              key={tab.key}
              href={tab.href}
              className={`px-5 py-3 text-[11px] font-black uppercase tracking-widest transition-colors ${
                isActive
                  ? 'bg-black text-background'
                  : 'text-foreground hover:bg-black hover:text-background'
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
