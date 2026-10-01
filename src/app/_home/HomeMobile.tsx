'use client';

import Link from 'next/link';

import { ListStateMobile } from '@/components/ListState';
import { PoolMobileCard } from '@/components/pools/PoolMobileCard';
import { newsAge } from '@/lib/news-intel';
import { CAT_STYLE, type PoolRow } from '@/lib/pool-list';
import type { SideLabels } from '@/lib/use-pool-labels';

import type { PoolsView } from './home-view';
import type { NewsView } from './use-news';

// Home mobile (2a's mobile column, Material 3 Expressive). The round hero becomes the rounds-not-open card; the
// live-bets chips and the rounds list have no data and are left out. Because rounds are not live, the pools that
// close first follow the news, which 2a's mobile board does not have.

const display: React.CSSProperties = { fontFamily: 'var(--mako-font-display)', fontWeight: 800 };
const h2: React.CSSProperties = { margin: 0, ...display, fontSize: 22, letterSpacing: '-0.02em' };
const BAR = 'color-mix(in srgb, var(--mako-canvas-fg) 16%, transparent)';
/// ListStateMobile pads its card 12px from the edge; 4px more gives the page's 16px gutter.
const GUTTER_FIX: React.CSSProperties = { padding: '0 4px' };

type Props = {
  pools: PoolsView;
  labelsOf: (r: PoolRow) => SideLabels;
  retry: () => void;
  news: NewsView;
  nowMs: number | null;
};

export function HomeMobile({ pools, labelsOf, retry, news, nowMs }: Props) {
  return (
    <div style={{ paddingBottom: 24 }}>
      <section aria-label="Rounds" style={{ ...GUTTER_FIX, marginTop: -12 }}>
        <ListStateMobile kind="rounds" state="not_open" />
      </section>

      <section aria-labelledby="home-intel-m">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '24px 20px 12px' }}>
          <h2 id="home-intel-m" style={h2}>
            Market intel
          </h2>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--dim)' }}>Latest</span>
          <Link href="/news" className="m3-press" style={{ marginLeft: 'auto', flex: 'none', height: 34, display: 'flex', alignItems: 'center', padding: '0 14px', borderRadius: 9999, background: 'var(--raise)', fontSize: 13, fontWeight: 700, color: 'inherit', textDecoration: 'none' }}>
            All news
          </Link>
        </div>
        {news.status === 'unavailable' ? (
          <p style={{ margin: 0, padding: '0 20px', fontSize: 15, lineHeight: 1.5, color: 'var(--dim)' }}>News is unavailable right now.</p>
        ) : (
          <ul
            className="no-scrollbar"
            aria-busy={news.status === 'loading' || undefined}
            aria-label={news.status === 'loading' ? 'Loading news' : undefined}
            style={{ listStyle: 'none', margin: 0, display: 'flex', gap: 10, overflowX: 'auto', scrollbarWidth: 'none', padding: '0 16px', scrollPaddingInline: 16 }}
          >
            {news.status === 'loading'
              ? [0, 1].map((i) => (
                  <li key={i} style={{ flex: 'none', width: 236, borderRadius: 24, background: 'var(--raise)', padding: 16 }}>
                    <div style={{ width: '50%', height: 12, borderRadius: 999, background: BAR }} />
                    <div style={{ width: '95%', height: 16, borderRadius: 8, background: BAR, marginTop: 12 }} />
                    <div style={{ width: '70%', height: 16, borderRadius: 8, background: BAR, marginTop: 6 }} />
                  </li>
                ))
              : news.items.map((n, i) => {
                  const body = (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, color: 'var(--dim)' }}>
                        <span aria-hidden="true" style={{ flex: 'none', width: 8, height: 8, borderRadius: '50%', background: CAT_STYLE[n.tag].bg }} />
                        {n.tag} · {newsAge(n.publishedAt, n.time, nowMs ?? Number.NaN).short}
                      </div>
                      <div style={{ fontSize: 15, fontWeight: 700, lineHeight: 1.3, marginTop: 8 }}>{n.title}</div>
                    </>
                  );
                  const card: React.CSSProperties = { display: 'block', height: '100%', boxSizing: 'border-box', borderRadius: 24, background: 'var(--raise)', padding: 16, color: 'inherit', textDecoration: 'none' };
                  return (
                    <li key={`${i}-${n.title}`} style={{ flex: 'none', width: 236 }}>
                      {n.url ? (
                        <a href={n.url} target="_blank" rel="noopener noreferrer" className="m3-press" style={card}>
                          {body}
                        </a>
                      ) : (
                        <div style={card}>{body}</div>
                      )}
                    </li>
                  );
                })}
          </ul>
        )}
      </section>

      <section aria-labelledby="home-pools-m">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '24px 20px 12px' }}>
          {pools.status === 'ready' && (
            <span aria-hidden="true" style={{ flex: 'none', width: 28, height: 28, borderRadius: 9999, boxShadow: 'inset 0 0 0 1.5px var(--m3-outline)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 800 }}>
              {pools.rows.length}
            </span>
          )}
          <h2 id="home-pools-m" style={h2}>
            Pools closing soon
          </h2>
          <Link href="/pools" className="m3-press" style={{ marginLeft: 'auto', flex: 'none', height: 34, display: 'flex', alignItems: 'center', padding: '0 14px', borderRadius: 9999, background: 'var(--raise)', fontSize: 13, fontWeight: 700, color: 'inherit', textDecoration: 'none' }}>
            All pools
          </Link>
        </div>
        {pools.status === 'ready' ? (
          <ul style={{ listStyle: 'none', margin: 0, display: 'flex', flexDirection: 'column', gap: 12, padding: '0 16px' }}>
            {pools.rows.map((r) => (
              <li key={r.id.toString()}>
                <PoolMobileCard row={r} labels={labelsOf(r)} />
              </li>
            ))}
          </ul>
        ) : (
          <div style={{ ...GUTTER_FIX, marginTop: -18 }}>
            <ListStateMobile kind="pools" state={pools.status} onRetry={retry} />
          </div>
        )}
      </section>
    </div>
  );
}
