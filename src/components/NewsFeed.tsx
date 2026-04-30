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
        <div className="mako-label text-chrome-fg/50">INTEL FEED UNAVAILABLE</div>
      </div>
    );
  }

  if (!items) {
    return (
      <div className="flex flex-col p-4 gap-3">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="p-3 bg-chrome-fg/5 rounded-lg border border-chrome-divider">
            <div className="flex items-center gap-2 mb-2">
              <span
                className="w-14 h-3 bg-chrome-fg/10 animate-pulse inline-block rounded"
                aria-hidden
              />
              <span
                className="w-10 h-3 bg-chrome-fg/10 animate-pulse inline-block rounded"
                aria-hidden
              />
            </div>
            <div className="w-full h-3 bg-chrome-fg/10 animate-pulse mb-1.5 rounded" aria-hidden />
            <div className="w-2/3 h-3 bg-chrome-fg/10 animate-pulse rounded" aria-hidden />
          </div>
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col p-6">
        <div className="mako-label text-chrome-fg/50">INTEL FEED EMPTY</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col p-4 gap-2">
      {items.map((news, i) => {
        const chipClass = tagChip(news.tag);
        const content = (
          <>
            <div className="flex items-center gap-2 mb-2">
              <span
                className={`text-[9px] font-black tracking-widest uppercase px-1.5 py-0.5 rounded ${chipClass}`}
              >
                {news.tag}
              </span>
              <span className="text-[9px] font-black tracking-widest uppercase text-chrome-fg/50 tabular-nums">
                {news.time}
              </span>
              {news.kind === 'event' && (
                <span className="text-[9px] font-black tracking-widest uppercase text-signal flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-signal inline-block animate-pulse" />
                  LIVE
                </span>
              )}
            </div>
            <h3 className="text-sm font-semibold leading-relaxed text-chrome-fg group-hover:text-link-hover transition-colors">
              {news.title}
            </h3>
          </>
        );
        // Belt-and-suspenders with the server-side protocol filter in
        // /api/news. Even if a malicious URL slipped past the server
        // (e.g. cache, middleware, SSRF), never emit a non-http(s) href.
        const safeHref = news.url && /^https?:\/\//i.test(news.url) ? news.url : undefined;
        const base =
          'flex flex-col p-3 rounded-lg border border-chrome-divider transition-colors';
        return safeHref ? (
          <a
            key={i}
            href={safeHref}
            target="_blank"
            rel="noopener noreferrer"
            className={`${base} hover:bg-chrome-fg/5 hover:border-chrome-divider group cursor-pointer`}
          >
            {content}
          </a>
        ) : (
          <div key={i} className={`${base} group cursor-default`}>
            {content}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Per-category chip styling. NBA pops red, CRYPTO gets the signal yellow,
 * FOOTBALL uses cream on ink-border — three distinct looks so the feed
 * reads as a palette, not a stack of identical tags.
 */
function tagChip(tag: Tag): string {
  if (tag === 'NBA') return 'bg-mako-red text-paper';
  if (tag === 'CRYPTO') return 'bg-signal text-ink';
  return 'bg-chrome-fg text-chrome'; // FOOTBALL — auto-inverts with theme
}
