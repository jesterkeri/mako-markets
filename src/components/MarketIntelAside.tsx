import { NewsFeed } from '@/components/NewsFeed';

/**
 * Right-hand sticky column that renders on xl+ screens across every page.
 * Ink-filled panel with cream text, headed "MARKET INTEL". Scrolls
 * independently from the main feed via an inner `overflow-y-auto` wrapper.
 *
 * Layout: the aside itself doesn't scroll; its h-12 header sits flush at
 * the top (aligned with the Sidebar brand row + main page header), and an
 * inner `flex-1 overflow-y-auto` wrapper scrolls just the NewsFeed.
 */
export function MarketIntelAside() {
  return (
    <aside className="hidden xl:flex flex-col w-80 2xl:w-96 border-l-2 border-ink bg-ink text-paper shrink-0 sticky top-0 self-start h-[calc(100dvh-2.25rem)]">
      <div className="px-6 h-12 border-b-2 border-paper/20 flex items-center shrink-0">
        <span className="mako-display text-sm lg:text-base text-paper">MARKET INTEL</span>
      </div>
      <div className="flex-1 overflow-y-auto no-scrollbar">
        <NewsFeed />
      </div>
    </aside>
  );
}
