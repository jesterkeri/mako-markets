'use client';

import { useQuery } from '@tanstack/react-query';

import { parseNews, type IntelItem } from '@/lib/news-intel';

export type NewsView = { status: 'loading' } | { status: 'unavailable' } | { status: 'ready'; items: IntelItem[] };

/// How many headline columns Home's Market intel lays out when the stories fit (2a: four across) and how many
/// skeletons show while loading. Home shows every story the feed has; past what fits, the strip crawls (IntelStrip).
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

/// Home's market intel: every item of the feed, newest first (the route caps it at 30), from the same read as /news
/// (Joshua, 2026-10-16: the strip moves through all the latest stories, not only four).
export function useNews(): NewsView {
  return useNewsFeed();
}
