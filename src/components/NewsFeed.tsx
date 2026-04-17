'use client';

import { useEffect, useState } from 'react';

/**
 * Renders the right-side MARKET INTEL panel (xl+ only, same as before).
 * Fetches from /api/news which aggregates real data:
 *   - Recent FINISHED matches from football-data.org
 *   - Recent Final NBA games from balldontlie
 *   - CoinGecko 24h movers
 *   - NewsAPI headlines (augment, optional)
 *
 * Loading: 5 skeleton pulse rows. Error / empty: single "INTEL FEED
 * UNAVAILABLE" row. Derived items always resolve, so we should essentially
 * never see the empty state unless all three upstream APIs are down.
 */

type Tag = 'FOOTBALL' | 'CRYPTO' | 'NBA';
type NewsItem = {
  kind: 'headline' | 'event';
  tag: Tag;
  title: string;
  time: string;
  url?: string;
};

export function NewsFeed() {
  const [items, setItems] = useState<NewsItem[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const res = await fetch('/api/news', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { items: NewsItem[] };
        if (cancelled) return;
        setItems(data.items ?? []);
        setFailed(false);
      } catch {
        if (!cancelled) setFailed(true);
      }
    };

    load();
    const id = setInterval(load, 5 * 60 * 1000); // re-poll every 5 min
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (failed && !items) {
    return (
      <div className="flex flex-col p-6">
        <div className="text-[10px] font-black tracking-widest uppercase text-muted">
          INTEL FEED UNAVAILABLE
        </div>
      </div>
    );
  }

  if (!items) {
    return (
      <div className="flex flex-col divide-y divide-black/20 p-6 gap-6">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="pt-6 first:pt-0">
            <div className="flex items-center gap-2 mb-2">
              <span className="w-16 h-3 bg-black/10 animate-pulse inline-block" aria-hidden />
              <span className="w-12 h-3 bg-black/10 animate-pulse inline-block" aria-hidden />
            </div>
            <div className="w-full h-4 bg-black/10 animate-pulse" aria-hidden />
          </div>
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col p-6">
        <div className="text-[10px] font-black tracking-widest uppercase text-muted">
          INTEL FEED EMPTY
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col divide-y divide-black/20 p-6 gap-6">
      {items.map((news, i) => {
        const content = (
          <>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[9px] font-black tracking-widest uppercase text-warning bg-warning/10 px-1.5 py-0.5">
                {news.tag}
              </span>
              <span className="text-[9px] font-black tracking-widest uppercase text-muted">
                {news.time}
              </span>
              {news.kind === 'event' && (
                <span className="text-[9px] font-black tracking-widest uppercase text-subtle">
                  LIVE
                </span>
              )}
            </div>
            <h3 className="text-sm font-black uppercase leading-snug group-hover:text-warning transition-colors">
              {news.title}
            </h3>
          </>
        );
        return news.url ? (
          <a
            key={i}
            href={news.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex flex-col pt-6 first:pt-0 group cursor-pointer"
          >
            {content}
          </a>
        ) : (
          <div key={i} className="flex flex-col pt-6 first:pt-0 group cursor-default">
            {content}
          </div>
        );
      })}
    </div>
  );
}
