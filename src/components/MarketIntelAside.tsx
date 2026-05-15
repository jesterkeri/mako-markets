'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { NewsFeed } from '@/components/NewsFeed';

/**
 * Right-hand sticky column. Ink-filled panel with cream text, headed
 * "MARKET INTEL". Scrolls independently from the main feed via an
 * inner `overflow-y-auto` wrapper.
 *
 * Visibility gated by available space, NOT a viewport class. The aside
 * shows only when the page can fit Sidebar (80px) + two MarketCards at
 * their minimum readable width (260 × 2 = 520) + gap (~40) + aside
 * itself (256) ≈ 896px of viewport. Round to a 960px threshold for
 * breathing room. Below that, the aside hides so cards keep their
 * minimum width instead of word-by-word truncating.
 *
 * Width ramps once visible: 256 (default-on) → 320 (xl) → 384 (2xl).
 *
 * Layout: the aside itself doesn't scroll; its h-12 header sits flush
 * at the top (aligned with the Sidebar brand row + main page header),
 * and an inner `flex-1 overflow-y-auto` wrapper scrolls just the
 * NewsFeed.
 */
export function MarketIntelAside() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  
  // /market/[id] reserves a 400px right column for the BetSheet at
  // lg+. Adding the aside in the same band would force a four-column
  // squeeze (sidebar 80 + content + BetSheet 400 + aside 256 ≈ 736
  // reserved on a 1024 viewport, leaving the question title in <290
  // px). Hide the aside on this route below xl so the page gets a
  // clean three-column look at lg, and only re-introduce the aside
  // at xl+ where the viewport (1280+) has the room for all four
  // columns.
  const isMarketDetail = pathname?.startsWith('/market/') ?? false;
  
  const isPrivateCreateForm = pathname === '/create/private' && searchParams?.has('shape');
  const isPublicCreateForm = pathname === '/create' && searchParams?.has('tab');
  const isFormActive = isPrivateCreateForm || isPublicCreateForm;

  // The user wants to hide the market intel sidebar completely on the active create
  // form pages to give the wide neo-brutalist side-by-side layout enough space.
  // HOWEVER, on the picker screens (where no shape/tab is selected), the sidebar 
  // should remain visible to fill the right-hand column.
  if (isFormActive) {
    return null;
  }

  const visibilityClasses = isMarketDetail
    ? 'hidden xl:flex'
    : 'hidden min-[960px]:flex';

  return (
    <aside className={`${visibilityClasses} flex-col w-64 xl:w-80 2xl:w-96 border-l-2 border-chrome-divider bg-chrome text-chrome-fg shrink-0 sticky top-0 self-start h-[calc(100dvh-2.25rem)]`}>
      <div className="px-6 h-12 border-b-2 border-chrome-divider flex items-center shrink-0">
        <span className="mako-display text-sm lg:text-base text-chrome-fg">MARKET INTEL</span>
      </div>
      <div className="flex-1 overflow-y-auto no-scrollbar">
        <NewsFeed />
      </div>
    </aside>
  );
}
