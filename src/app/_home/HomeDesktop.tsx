'use client';

import Link from 'next/link';

import { ListActionButton, ListStateDesktop } from '@/components/ListState';
import { Mascot } from '@/components/Mascot';
import { HomeRoundsBand } from '@/components/rounds/HomeRounds';
import { poolHref } from '@/components/pools/PoolMobileCard';
import { listStateCopy } from '@/lib/list-states';
import { newsAge } from '@/lib/news-intel';
import { CAT_STYLE, formatPays, noOpenPoolsTitle, POOL_FILTERS, usdc2, type PoolFilter, type PoolRow } from '@/lib/pool-list';
import type { SideLabels } from '@/lib/use-pool-labels';

import { DESK_ROWS, HOME_MAKO_ROWS, type MakoView, type PoolsView } from './home-view';
import { INTEL_COUNT, type NewsView } from './use-news';

// Home desktop (2a): terminal look, hairline rules, mono numbers, pill controls, no card panels.

const mono: React.CSSProperties = { fontFamily: 'var(--mako-font-mono)' };
const display: React.CSSProperties = { fontFamily: 'var(--mako-font-display)', fontWeight: 800 };
const h2: React.CSSProperties = { margin: 0, ...display, fontSize: 24, letterSpacing: '-0.02em' };
/// The Mako markets and Pools column headers share one box, so their titles and the rules under them form one line
/// (Joshua, 2026-10-07).
const colHead: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 18, minHeight: 32, padding: '14px 14px 12px 20px' };
const BAR = 'color-mix(in srgb, var(--mako-canvas-fg) 16%, transparent)';
/// 2a's pools table: market, YES, NO, pool, closes.
const COLS = 'minmax(0,1fr) 96px 96px 120px 90px';

type Props = {
  pools: PoolsView;
  mako: MakoView;
  filter: PoolFilter;
  setFilter: (f: PoolFilter) => void;
  labelsOf: (r: PoolRow) => SideLabels;
  retry: () => void;
  news: NewsView;
  nowMs: number | null;
};

export function HomeDesktop({ pools, mako, filter, setFilter, labelsOf, retry, news, nowMs }: Props) {
  return (
    <div style={{ paddingBottom: 8 }}>
      <HomeRoundsBand fallback={<RoundsNotOpenBand />} />
      <div style={{ display: 'grid', gridTemplateColumns: '360px minmax(0,1fr)', marginTop: 22 }}>
        <MakoColumn mako={mako} />
        <PoolsColumn pools={pools} filter={filter} setFilter={setFilter} labelsOf={labelsOf} retry={retry} />
      </div>
      <MarketIntel news={news} nowMs={nowMs} />
    </div>
  );
}

/// In place of 2a's next-round strip and hero: rounds are not live yet, and Pools are.
function RoundsNotOpenBand() {
  const c = listStateCopy('rounds', 'not_open');
  const button: React.CSSProperties = { height: 50, display: 'inline-flex', alignItems: 'center', padding: '0 22px', borderRadius: 9999, ...display, fontSize: 16, whiteSpace: 'nowrap' };
  return (
    <section aria-labelledby="home-rounds-title" style={{ display: 'flex', alignItems: 'center', gap: 26, padding: '18px 22px', borderTop: '1px solid var(--line)', boxShadow: 'inset 0 -1px 0 var(--line)' }}>
      <Mascot pose={c.pose} motion={c.motion} alt="" style={{ flex: 'none', height: 112, width: 'auto' }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.15em', textTransform: 'uppercase', color: 'var(--dim)' }}>Rounds</div>
        <h2 id="home-rounds-title" style={{ margin: '6px 0 0', ...display, fontSize: 48, lineHeight: 1, letterSpacing: '-0.03em' }}>
          {c.title}
        </h2>
        <p style={{ margin: '10px 0 0', fontSize: 15, lineHeight: 1.5, color: 'var(--dim)' }}>{c.body}</p>
      </div>
      <div style={{ flex: 'none', display: 'flex', gap: 10 }}>
        <ListActionButton action={c.primary} className="mk-press96" style={{ ...button, background: 'var(--mako-signal)', color: '#000', boxShadow: 'var(--edge)' }} />
        <ListActionButton action={c.secondary} className="mk-press96" style={{ ...button, background: 'var(--raise2)', color: 'var(--mako-canvas-fg)' }} />
      </div>
    </section>
  );
}

/// The column beside Pools (Joshua, 2026-10-15; it was 2a's Rounds list): Mako Market's own open pools, most players
/// first, then the bigger pot, then the newest. A failed read leaves the retry to the pools table beside it.
function MakoColumn({ mako }: { mako: MakoView }) {
  const note: React.CSSProperties = { margin: 0, padding: '14px 20px', boxShadow: 'inset 0 1px 0 var(--line)', fontSize: 14, lineHeight: 1.5, color: 'var(--dim)' };
  return (
    <section aria-labelledby="home-mako-col" style={{ borderTop: '1px solid var(--line)', display: 'flex', flexDirection: 'column' }}>
      <div style={colHead}>
        <h2 id="home-mako-col" style={h2}>
          Mako markets
        </h2>
        {mako.status === 'ready' && mako.total > 0 && <span style={{ ...mono, fontSize: 12, color: 'var(--dim)' }}>{mako.total}</span>}
        <Link href="/pools" style={{ marginLeft: 'auto', ...mono, fontSize: 11, fontWeight: 700, color: 'var(--dim)', textDecoration: 'none' }}>
          ALL →
        </Link>
      </div>
      {mako.status === 'error' ? (
        <p style={note}>Mako markets can’t be loaded right now.</p>
      ) : mako.status === 'loading' ? (
        <div aria-busy="true" aria-label="Loading Mako markets">
          {Array.from({ length: HOME_MAKO_ROWS }, (_, i) => (
            <div key={i} style={{ padding: '12px 20px', boxShadow: 'inset 0 1px 0 var(--line)', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ width: '55%', height: 10, borderRadius: 8, background: BAR }} />
              <div style={{ width: '85%', height: 14, borderRadius: 8, background: BAR }} />
            </div>
          ))}
        </div>
      ) : mako.rows.length === 0 ? (
        <p style={note}>
          No Mako market is open right now.{' '}
          <Link href="/pools" style={{ color: 'var(--mako-canvas-fg)', fontWeight: 700 }}>
            Go to Pools
          </Link>
        </p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {mako.rows.map((r) => (
            <li key={r.id.toString()}>
              <Link href={poolHref(r.id)} className="mk-row" style={{ display: 'block', padding: '12px 20px', boxShadow: 'inset 0 1px 0 var(--line)', color: 'inherit', textDecoration: 'none' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, ...mono, fontSize: 11, color: 'var(--dim)' }}>
                  <span>
                    #{r.id.toString()} · {r.bettors} {r.bettors === 1 ? 'PLAYER' : 'PLAYERS'} · CLOSES {r.closes}
                  </span>
                  <span style={{ whiteSpace: 'nowrap' }}>{usdc2(r.pool)} USDC</span>
                </div>
                <div style={{ ...display, fontSize: 17, marginTop: 4 }}>{r.question}</div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PoolsColumn({ pools, filter, setFilter, labelsOf, retry }: Pick<Props, 'pools' | 'filter' | 'setFilter' | 'labelsOf' | 'retry'>) {
  return (
    <section aria-labelledby="home-pools" style={{ borderTop: '1px solid var(--line)', borderLeft: '1px solid var(--line)', minWidth: 0 }}>
      <div style={colHead}>
        <h2 id="home-pools" style={h2}>
          Pools
        </h2>
        {pools.status === 'ready' && (
          <div role="group" aria-label="Category" style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
            {POOL_FILTERS.map((c) => {
              const on = c === filter;
              return (
                <button
                  key={c}
                  onClick={() => setFilter(c)}
                  aria-pressed={on}
                  className="mk-press96"
                  style={{ height: 32, display: 'flex', alignItems: 'center', padding: '0 12px', borderRadius: 9999, background: on ? 'var(--mako-canvas-fg)' : 'var(--raise)', color: on ? 'var(--mako-canvas)' : 'var(--mako-canvas-fg)', ...mono, fontSize: 11, fontWeight: 700 }}
                >
                  {c}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {pools.status === 'error' || pools.status === 'empty' ? (
        <ListStateDesktop kind="pools" state={pools.status} onRetry={retry} />
      ) : (
        <>
          <div aria-hidden="true" style={{ display: 'grid', gridTemplateColumns: COLS, gap: '0 12px', padding: '8px 20px', boxShadow: 'inset 0 1px 0 var(--line)', ...mono, fontSize: 11, color: 'var(--dim)' }}>
            <span>MARKET</span>
            <span>YES</span>
            <span>NO</span>
            <span style={{ textAlign: 'right' }}>POOL</span>
            <span style={{ textAlign: 'right' }}>CLOSES</span>
          </div>
          {pools.status === 'loading' ? (
            <div aria-busy="true" aria-label="Loading pools">
              {Array.from({ length: DESK_ROWS }, (_, i) => (
                <SkeletonRow key={i} />
              ))}
            </div>
          ) : pools.rows.length === 0 ? (
            <p style={{ margin: 0, padding: '28px 20px', boxShadow: 'inset 0 1px 0 var(--line)', fontSize: 15, color: 'var(--dim)' }}>{noOpenPoolsTitle(filter)}</p>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {pools.rows.map((r) => (
                <li key={r.id.toString()}>
                  <PoolRowDesk row={r} labels={labelsOf(r)} />
                </li>
              ))}
            </ul>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '14px 20px', boxShadow: 'inset 0 1px 0 var(--line)' }}>
            <Link href="/pools" className="mk-press96" style={{ ...display, fontSize: 15, color: 'inherit', textDecoration: 'none' }}>
              All pools →
            </Link>
          </div>
        </>
      )}
    </section>
  );
}

function PoolRowDesk({ row: r, labels }: { row: PoolRow; labels: SideLabels }) {
  const cat = CAT_STYLE[r.cat];
  const side = (label: string, pays: number | null, bg: string, q: 'yes' | 'no') => {
    const figure = formatPays(pays);
    return (
      <Link
        href={`${poolHref(r.id)}?side=${q}`}
        aria-label={figure ? `${label}, pays ${figure} per 1 USDC` : `${label}, no stake on this side yet`}
        className="mk-press96 mk-over"
        style={{ minWidth: 0, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, padding: '0 10px', borderRadius: 9999, background: bg, color: 'var(--mako-on-side)', boxShadow: 'var(--edge)', ...mono, fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap', textDecoration: 'none' }}
      >
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
        <span style={{ flex: 'none' }}>{figure || 'No bets'}</span>
      </Link>
    );
  };
  return (
    <div className="mk-row" style={{ display: 'grid', gridTemplateColumns: COLS, gap: '0 12px', alignItems: 'center', padding: '10px 20px', boxShadow: 'inset 0 1px 0 var(--line)' }}>
      <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 12 }}>
        <span aria-hidden="true" style={{ flex: 'none', width: 34, height: 34, borderRadius: 9999, background: cat.bg, color: cat.fg, display: 'flex', alignItems: 'center', justifyContent: 'center', ...mono, fontSize: 10, fontWeight: 700, boxShadow: 'var(--edge)' }}>
          {cat.abbr}
        </span>
        <div style={{ minWidth: 0 }}>
          <Link href={poolHref(r.id)} className="mk-rowlink" style={{ display: 'block', fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: 'inherit', textDecoration: 'none' }}>
            {r.question}
          </Link>
          <div style={{ ...mono, fontSize: 11, color: 'var(--dim)', marginTop: 2 }}>
            {r.bettors} {r.bettors === 1 ? 'bettor' : 'bettors'}
          </div>
        </div>
      </div>
      {side(labels.yes, r.yesPays, 'var(--mako-yes)', 'yes')}
      {side(labels.no, r.noPays, 'var(--mako-no)', 'no')}
      <span style={{ textAlign: 'right', ...mono, fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap' }}>{usdc2(r.pool)} USDC</span>
      <span style={{ textAlign: 'right', ...mono, fontSize: 13, color: 'var(--mako-red)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{r.closes}</span>
    </div>
  );
}

function SkeletonRow() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: COLS, gap: '0 12px', alignItems: 'center', padding: '10px 20px', boxShadow: 'inset 0 1px 0 var(--line)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ flex: 'none', width: 34, height: 34, borderRadius: 9999, background: BAR }} />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ width: '70%', height: 14, borderRadius: 8, background: BAR }} />
          <div style={{ width: 60, height: 10, borderRadius: 8, background: BAR }} />
        </div>
      </div>
      <div style={{ height: 34, borderRadius: 9999, background: BAR }} />
      <div style={{ height: 34, borderRadius: 9999, background: BAR }} />
      <div style={{ justifySelf: 'end', width: 96, height: 13, borderRadius: 8, background: BAR }} />
      <div style={{ justifySelf: 'end', width: 52, height: 13, borderRadius: 8, background: BAR }} />
    </div>
  );
}

/// 2a's Market intel: the newest four headlines. Not a live feed (the route caches for 15 minutes), so it is labelled
/// LATEST; "All news" opens the whole feed (3a).
function MarketIntel({ news, nowMs }: { news: NewsView; nowMs: number | null }) {
  return (
    <section aria-labelledby="home-intel" style={{ marginTop: 22, borderTop: '1px solid var(--line)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, padding: '16px 20px 12px' }}>
        <h2 id="home-intel" style={h2}>
          Market intel
        </h2>
        <span style={{ ...mono, fontSize: 11, color: 'var(--dim)' }}>LATEST</span>
        <Link href="/news" className="mk-press96" style={{ marginLeft: 'auto', ...display, fontSize: 15, color: 'inherit', textDecoration: 'none' }}>
          All news →
        </Link>
      </div>
      {news.status === 'unavailable' ? (
        <p style={{ margin: 0, padding: '14px 20px 18px', boxShadow: 'inset 0 1px 0 var(--line)', fontSize: 14, color: 'var(--dim)' }}>News is unavailable right now.</p>
      ) : (
        <ul aria-busy={news.status === 'loading' || undefined} aria-label={news.status === 'loading' ? 'Loading news' : undefined} style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: `repeat(${INTEL_COUNT},minmax(0,1fr))`, boxShadow: 'inset 0 1px 0 var(--line)' }}>
          {news.status === 'loading'
            ? Array.from({ length: INTEL_COUNT }, (_, i) => (
                <li key={i} style={{ padding: '14px 20px 18px', display: 'flex', flexDirection: 'column', gap: 10, boxShadow: 'inset -1px 0 0 var(--line)' }}>
                  <div style={{ width: '45%', height: 11, borderRadius: 8, background: BAR }} />
                  <div style={{ width: '92%', height: 14, borderRadius: 8, background: BAR }} />
                  <div style={{ width: '65%', height: 14, borderRadius: 8, background: BAR }} />
                </li>
              ))
            : news.items.map((n, i) => {
                const age = newsAge(n.publishedAt, n.time, nowMs ?? Number.NaN).long;
                return (
                  <li key={`${i}-${n.title}`} className={n.url ? 'mk-row' : undefined} style={{ position: 'relative', padding: '14px 20px 18px', display: 'flex', flexDirection: 'column', gap: 8, boxShadow: 'inset -1px 0 0 var(--line)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, ...mono, fontSize: 11 }}>
                      <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: CAT_STYLE[n.tag].bg }} />
                      <span style={{ fontWeight: 700 }}>{n.tag}</span>
                      <span style={{ color: 'var(--dim)' }}>{age}</span>
                    </div>
                    {n.url ? (
                      <a href={n.url} target="_blank" rel="noopener noreferrer" className="mk-rowlink" style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.4, textWrap: 'pretty', color: 'inherit', textDecoration: 'none' }}>
                        {n.title}
                      </a>
                    ) : (
                      <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.4, textWrap: 'pretty' }}>{n.title}</div>
                    )}
                  </li>
                );
              })}
        </ul>
      )}
    </section>
  );
}
