'use client';

import { useState } from 'react';

import { CAT_STYLE } from '@/lib/pool-list';
import { INTEL_TAGS, newsAge, newsGroup, newsSource, type IntelItem, type IntelTag, type NewsGroup } from '@/lib/news-intel';
import { useLiveNowSec } from '@/lib/use-live-clock';

import { useNewsFeed, type NewsView } from '../_home/use-news';

// Market intel (3a): the whole `GET /api/news` feed with the design's category pills, the newest story as the lead,
// then the rest by age (last hour, earlier today, earlier). Ages are worked out in the browser from `publishedAt`
// (the route caches for 15 minutes), so the page says LATEST, not live. Each story links to its source in a new
// tab, http(s) only (parseNews drops anything else). Stories are not linked to pools or rounds yet, so the design's
// "related" slots show as coming soon.

type Cat = 'ALL' | IntelTag;
const CATS: readonly Cat[] = ['ALL', ...INTEL_TAGS];

const display: React.CSSProperties = { fontFamily: 'var(--mako-font-display)', fontWeight: 800 };
const mono: React.CSSProperties = { fontFamily: 'var(--mako-font-mono)' };
const BAR = 'color-mix(in srgb, var(--mako-canvas-fg) 16%, transparent)';
const GROUPS: readonly { key: NewsGroup; desk: string; mob: string }[] = [
  { key: 'last', desk: 'LAST HOUR', mob: 'Last hour' },
  { key: 'today', desk: 'EARLIER TODAY', mob: 'Earlier today' },
  { key: 'earlier', desk: 'EARLIER', mob: 'Earlier' },
];
const ARROW = 'M7.5 16.5l9-9M9.5 7.5h7v7';

const catTitle = (c: Cat) => (c === 'ALL' ? 'All' : c === 'NBA' ? 'NBA' : c[0] + c.slice(1).toLowerCase());
const stories = (n: number) => (n === 1 ? '1 story' : `${n} stories`);

type Story = { item: IntelItem; source: string | null; ageLong: string; ageShort: string; group: NewsGroup };

type View = {
  state: 'loading' | 'unavailable' | 'ready';
  cat: Cat;
  setCat: (c: Cat) => void;
  lead: Story | null;
  groups: { key: NewsGroup; desk: string; mob: string; stories: Story[] }[];
  count: number;
};

function buildView(feed: NewsView, cat: Cat, setCat: (c: Cat) => void, nowMs: number | null): View {
  if (feed.status !== 'ready' || nowMs === null) return { state: feed.status === 'unavailable' ? 'unavailable' : 'loading', cat, setCat, lead: null, groups: [], count: 0 };
  const shown: Story[] = feed.items
    .filter((i) => cat === 'ALL' || i.tag === cat)
    .map((item) => {
      const age = newsAge(item.publishedAt, item.time, nowMs);
      return { item, source: newsSource(item.url), ageLong: age.long, ageShort: age.short === 'Now' ? 'NOW' : age.short, group: newsGroup(item.publishedAt, nowMs) };
    });
  const [lead = null, ...rest] = shown;
  return {
    state: 'ready',
    cat,
    setCat,
    lead,
    groups: GROUPS.map((g) => ({ ...g, stories: rest.filter((s) => s.group === g.key) })).filter((g) => g.stories.length > 0),
    count: shown.length,
  };
}

export function NewsClient() {
  const feed = useNewsFeed();
  const now = useLiveNowSec();
  const [cat, setCat] = useState<Cat>('ALL');
  const view = buildView(feed, cat, setCat, now === null ? null : now * 1000);
  return (
    <>
      <div className="mk-desk mk-desk-frame">
        <NewsDesktop {...view} />
      </div>
      <div className="mk-mob mk-m">
        <NewsMobile {...view} />
      </div>
    </>
  );
}

function Svg({ d, size }: { d: string; size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

/// A story's title: its link when it has one (a new tab, never an opener), plain text otherwise. `stretch` makes the
/// link cover its row (the row's `.mk-row`).
function Title({ item, style, stretch }: { item: IntelItem; style: React.CSSProperties; stretch?: boolean }) {
  if (!item.url) return <div style={style}>{item.title}</div>;
  return (
    <a href={item.url} target="_blank" rel="noopener noreferrer" className={stretch ? 'mk-rowlink' : undefined} style={{ ...style, display: 'block', color: 'inherit', textDecoration: 'none' }}>
      {item.title}
    </a>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Desktop

function NewsDesktop(v: View) {
  return (
    <div style={{ paddingBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 20, padding: '16px 4px 20px' }}>
        <div>
          <h1 style={{ margin: 0, ...display, fontSize: 64, lineHeight: 1, letterSpacing: '-0.04em' }}>Market intel</h1>
        </div>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, ...mono, fontSize: 12, color: 'var(--dim)' }}>
          <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--dim)' }} />
          LATEST{v.state === 'ready' ? ` · ${stories(v.count)}` : ''}
        </span>
        <div role="group" aria-label="Category" style={{ marginLeft: 'auto', display: 'flex', gap: 4, padding: 4, borderRadius: 9999, background: 'var(--raise)' }}>
          {CATS.map((c) => {
            const on = c === v.cat;
            return (
              <button
                key={c}
                type="button"
                onClick={() => v.setCat(c)}
                aria-pressed={on}
                className="mk-press96"
                style={{ height: 34, padding: '0 13px', borderRadius: 9999, background: on ? 'var(--mako-canvas-fg)' : 'transparent', color: on ? 'var(--mako-canvas)' : 'var(--mako-canvas-fg)', ...mono, fontSize: 11, fontWeight: 700, transition: 'background-color 200ms ease' }}
              >
                {c}
              </button>
            );
          })}
        </div>
      </div>

      {v.state === 'unavailable' && <div style={{ borderTop: '1px solid var(--line)', padding: '40px 4px', fontSize: 16, color: 'var(--dim)' }}>News is unavailable right now.</div>}
      {v.state === 'loading' && <DeskSkeleton />}
      {v.state === 'ready' && !v.lead && <div style={{ borderTop: '1px solid var(--line)', padding: '40px 4px', fontSize: 16, color: 'var(--dim)' }}>No {catTitle(v.cat)} stories right now.</div>}

      {v.lead && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.6fr) minmax(0,1fr)', gap: 28 }}>
          <div className={v.lead.item.url ? 'mk-row' : undefined} style={{ borderTop: '1px solid var(--line)', padding: '26px 4px', display: 'flex', flexDirection: 'column', gap: 14, minHeight: 260, boxSizing: 'border-box' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, ...mono, fontSize: 12 }}>
              <span style={{ height: 24, display: 'flex', alignItems: 'center', padding: '0 10px', borderRadius: 9999, background: CAT_STYLE[v.lead.item.tag].bg, color: CAT_STYLE[v.lead.item.tag].fg, fontWeight: 700, boxShadow: 'var(--edge)' }}>{v.lead.item.tag}</span>
              <span style={{ color: 'var(--dim)' }}>
                {v.lead.ageLong}
                {v.lead.source ? ` · ${v.lead.source}` : ''}
              </span>
            </div>
            <Title item={v.lead.item} stretch style={{ ...display, fontSize: 40, lineHeight: 1.05, letterSpacing: '-0.03em', textWrap: 'pretty' }} />
          </div>
          <div aria-label="Related round, coming soon" style={{ background: 'var(--mako-signal)', color: '#000', borderRadius: 14, padding: '24px 26px', marginTop: 20, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 16, boxShadow: 'var(--edge)' }}>
            <span style={{ ...mono, fontSize: 12, fontWeight: 700 }}>RELATED ROUND</span>
            <span style={{ ...display, fontSize: 28, lineHeight: 1.1, letterSpacing: '-0.02em' }}>Rounds open soon</span>
            <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', ...mono, fontSize: 14, fontWeight: 700 }}>
              <span>NOT LIVE YET</span>
              <span aria-disabled="true" style={{ height: 44, display: 'flex', alignItems: 'center', padding: '0 20px', borderRadius: 9999, background: '#000', color: '#EBE5D9', ...display, fontSize: 16, boxShadow: 'var(--edge)', opacity: 0.55 }}>
                Coming soon
              </span>
            </span>
          </div>
        </div>
      )}

      {v.groups.map((g) => (
        <section key={g.key} aria-label={g.mob} style={{ marginTop: 24, borderTop: '1px solid var(--line)', overflow: 'hidden' }}>
          <div style={{ padding: '14px 4px', ...mono, fontSize: 11, fontWeight: 700, color: 'var(--dim)' }}>{g.desk}</div>
          {g.stories.map((s, i) => (
            <div key={`${i}-${s.item.title}`} className={s.item.url ? 'mk-row' : undefined} style={{ display: 'grid', gridTemplateColumns: '80px minmax(0,1fr) 340px', gap: 20, alignItems: 'center', padding: '16px 4px', boxShadow: 'inset 0 1px 0 var(--line)' }}>
              <div style={{ ...mono, fontSize: 12 }}>
                <div style={{ fontWeight: 700 }}>{s.ageShort}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, color: 'var(--dim)' }}>
                  <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%', background: CAT_STYLE[s.item.tag].bg }} />
                  {s.item.tag}
                </div>
              </div>
              <div style={{ minWidth: 0 }}>
                <Title item={s.item} stretch style={{ ...display, fontSize: 20, lineHeight: 1.2, letterSpacing: '-0.01em' }} />
                {s.source && <div style={{ ...mono, fontSize: 11, lineHeight: 1.5, color: 'var(--dim)', marginTop: 4 }}>{s.source}</div>}
              </div>
              <div aria-label="Related pool, coming soon" style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '12px 16px', borderRadius: 12, background: 'var(--raise2)', color: 'var(--mako-canvas-fg)', boxShadow: 'var(--edge)', opacity: 0.55 }}>
                <span style={{ ...mono, fontSize: 10, fontWeight: 700 }}>RELATED POOL</span>
                <span style={{ fontSize: 13, fontWeight: 700 }}>Coming soon</span>
              </div>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

function DeskSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading news" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.6fr) minmax(0,1fr)', gap: 28 }}>
      <div style={{ borderTop: '1px solid var(--line)', padding: '26px 4px', display: 'flex', flexDirection: 'column', gap: 14, minHeight: 260, boxSizing: 'border-box' }}>
        <div style={{ width: 180, height: 22, borderRadius: 9999, background: BAR }} />
        <div style={{ width: '90%', height: 38, borderRadius: 10, background: BAR }} />
        <div style={{ width: '60%', height: 38, borderRadius: 10, background: BAR }} />
      </div>
      <div style={{ marginTop: 20, borderRadius: 14, background: BAR, minHeight: 200 }} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Mobile

function NewsMobile(v: View) {
  return (
    <div>
      {/* A main tab since 2026-10-07 (News): the shell's own header, and a title like Pools and Rounds. */}
      <div style={{ padding: '6px 20px 0' }}>
        <h1 style={{ margin: 0, ...display, fontSize: 40, lineHeight: 1, letterSpacing: '-0.035em' }}>Market intel</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 15, color: 'var(--dim)', marginTop: 8 }}>
          <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--dim)' }} />
          Latest
        </div>
      </div>
      <div style={{ padding: '6px 16px 0' }}>
        <div role="group" aria-label="Category" className="no-scrollbar" style={{ display: 'flex', gap: 8, overflowX: 'auto', scrollbarWidth: 'none', padding: '2px 0' }}>
          {CATS.map((c) => {
            const on = c === v.cat;
            return (
              <button
                key={c}
                type="button"
                onClick={() => v.setCat(c)}
                aria-pressed={on}
                className="m3-press"
                style={{ flex: 'none', height: 40, display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px', borderRadius: 9999, background: on ? 'var(--mako-canvas-fg)' : 'var(--raise)', color: on ? 'var(--mako-canvas)' : 'var(--mako-canvas-fg)', fontSize: 14, fontWeight: 700, whiteSpace: 'nowrap', transition: 'background-color 250ms cubic-bezier(0.2,0,0,1)' }}
              >
                {catTitle(c)}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ padding: '14px 12px 0' }}>
        {v.state === 'unavailable' && (
          <div role="status" style={{ borderRadius: 28, background: 'var(--raise)', padding: '28px 20px', textAlign: 'center', fontSize: 15, color: 'var(--dim)' }}>
            News is unavailable right now.
          </div>
        )}
        {v.state === 'loading' && (
          <div aria-busy="true" aria-label="Loading news" style={{ borderRadius: 32, background: 'var(--raise)', padding: 20 }}>
            <div style={{ width: '40%', height: 24, borderRadius: 9999, background: BAR }} />
            <div style={{ width: '92%', height: 26, borderRadius: 8, background: BAR, marginTop: 16 }} />
            <div style={{ width: '70%', height: 26, borderRadius: 8, background: BAR, marginTop: 8 }} />
          </div>
        )}
        {v.state === 'ready' && !v.lead && (
          <div style={{ borderRadius: 28, background: 'var(--raise)', padding: '28px 20px', textAlign: 'center' }}>
            <div style={{ ...display, fontSize: 20 }}>No {catTitle(v.cat)} stories right now</div>
            <div style={{ fontSize: 14, color: 'var(--dim)', marginTop: 6 }}>Try another category.</div>
          </div>
        )}
        {v.lead && <MobileLead s={v.lead} />}
      </div>

      {v.groups.map((g) => (
        <section key={g.key} aria-label={g.mob}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '24px 20px 12px' }}>
            <h2 style={{ margin: 0, ...display, fontSize: 22, letterSpacing: '-0.02em' }}>{g.mob}</h2>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '0 12px' }}>
            {g.stories.map((s, i) => (
              <MobileCard key={`${i}-${s.item.title}`} s={s} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function meta(s: Story) {
  return [s.item.tag, s.ageShort === 'NOW' ? 'Now' : s.ageShort, s.source].filter(Boolean).join(' · ');
}

function MobileLead({ s }: { s: Story }) {
  const inner = (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ height: 28, display: 'flex', alignItems: 'center', gap: 6, padding: '0 12px', borderRadius: 9999, background: 'var(--m3-inv-2)', fontSize: 12, fontWeight: 800 }}>
          <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: CAT_STYLE[s.item.tag].bg }} />
          {s.item.tag}
        </span>
        <span style={{ fontSize: 13, fontWeight: 600, opacity: 0.65 }}>{[s.ageShort === 'NOW' ? 'Now' : s.ageShort, s.source].filter(Boolean).join(' · ')}</span>
      </div>
      <div style={{ ...display, fontSize: 26, lineHeight: 1.12, letterSpacing: '-0.02em', marginTop: 14 }}>{s.item.title}</div>
    </>
  );
  const card: React.CSSProperties = { display: 'block', color: 'inherit', textDecoration: 'none' };
  return (
    <div style={{ borderRadius: 32, background: 'var(--m3-inv)', color: 'var(--m3-inv-fg)', boxShadow: 'var(--edge)', padding: 20 }}>
      {s.item.url ? (
        <a href={s.item.url} target="_blank" rel="noopener noreferrer" style={card}>
          {inner}
        </a>
      ) : (
        <div style={card}>{inner}</div>
      )}
      <div aria-label="Related round, coming soon" style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16, borderRadius: 22, background: 'var(--mako-signal)', color: '#000', boxShadow: 'var(--edge)', padding: '14px 10px 14px 16px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 700, opacity: 0.7 }}>Related round</div>
          <div style={{ fontSize: 15, fontWeight: 800, marginTop: 2 }}>Rounds open soon</div>
          <div style={{ fontSize: 13, fontWeight: 600, opacity: 0.75, marginTop: 2 }}>Coming soon</div>
        </div>
        <span aria-hidden="true" style={{ flex: 'none', width: 40, height: 40, borderRadius: 9999, background: '#000', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.35 }}>
          <Svg d={ARROW} size={16} />
        </span>
      </div>
    </div>
  );
}

function MobileCard({ s }: { s: Story }) {
  const body = (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, color: 'var(--dim)' }}>
        <span aria-hidden="true" style={{ flex: 'none', width: 8, height: 8, borderRadius: '50%', background: CAT_STYLE[s.item.tag].bg }} />
        {meta(s)}
      </div>
      <div style={{ ...display, fontSize: 18, lineHeight: 1.22, letterSpacing: '-0.01em', marginTop: 8 }}>{s.item.title}</div>
      <span aria-label="Related pool, coming soon" style={{ marginTop: 12, height: 34, display: 'inline-flex', alignItems: 'center', gap: 8, padding: '0 14px', borderRadius: 9999, background: 'var(--raise2)', fontSize: 13, fontWeight: 700, opacity: 0.6 }}>
        Related pool · coming soon
      </span>
    </>
  );
  const card: React.CSSProperties = { display: 'block', borderRadius: 26, background: 'var(--raise)', padding: 16, color: 'inherit', textDecoration: 'none' };
  return s.item.url ? (
    <a href={s.item.url} target="_blank" rel="noopener noreferrer" className="m3-press" style={card}>
      {body}
    </a>
  ) : (
    <div style={card}>{body}</div>
  );
}
