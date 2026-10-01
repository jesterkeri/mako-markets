'use client';

import { useQuery } from '@tanstack/react-query';

import { latestIntel, parseNews, type IntelItem } from '@/lib/news-intel';

export type NewsView = { status: 'loading' } | { status: 'unavailable' } | { status: 'ready'; items: IntelItem[] };

/// How many headlines Home shows (2a: four across on desktop, a scrolling strip of the same four on mobile).
export const INTEL_COUNT = 4;

/// The whole feed from `GET /api/news`, re-read every 5 minutes; Home and /news share it. A failed read, or a feed
/// with no usable item (every upstream failed), is "unavailable": never an empty list that looks like there is no
/// news.
export function useNewsFeed(): NewsView {
  const q = useQuery({
    queryKey: ['home-news'],
    queryFn: async () => {
      const res = await fetch('/api/news', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const items = parseNews(await res.json());
      if (items === null) throw new Error('unexpected news body');
      return items;
    },
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
    retry: 1,
  });
  if (q.data) return q.data.length > 0 ? { status: 'ready', items: q.data } : { status: 'unavailable' };
  return q.isError ? { status: 'unavailable' } : { status: 'loading' };
}

/// Home's market intel: the newest INTEL_COUNT items of the feed.
export function useNews(): NewsView {
  const feed = useNewsFeed();
  return feed.status === 'ready' ? { status: 'ready', items: latestIntel(feed.items, INTEL_COUNT) } : feed;
}
