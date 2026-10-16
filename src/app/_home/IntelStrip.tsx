'use client';

import { useLayoutEffect, useRef, useState } from 'react';

import { newsAge, type IntelItem } from '@/lib/news-intel';
import { CAT_STYLE } from '@/lib/pool-list';

// Home's Market intel cards (Joshua, 2026-10-16): every story the feed has, moving slowly left in an endless loop
// once there are more than fit, paused under a fine pointer. The motion is one CSS animation on one track
// (mako-shell.css, `.mk-marquee`): transform only, linear, no JS loop. The list is drawn twice and the track slides by
// half its width, so the loop has no seam; the second copy is hidden from assistive tech and its links are out of the
// tab order, so each story is met once. While a card has keyboard focus, and always with reduced motion, the strip is a
// still row of one copy that scrolls (by focus, or by hand), so every card a reader reaches is on screen.

/// Every moving card is this wide, so one copy of the list is `count x INTEL_CARD_W` pixels.
export const INTEL_CARD_W = 320;
/// The crawl's speed, the same however many stories there are.
export const INTEL_PX_PER_SEC = 40;

/// Seconds for one full loop: one copy's width at INTEL_PX_PER_SEC.
export function marqueeDurationSec(count: number): number {
  return (Math.max(0, count) * INTEL_CARD_W) / INTEL_PX_PER_SEC;
}

/// Whether the strip moves: only when one copy is at least a card wider than the strip, so no story is ever on screen
/// twice (a copy just wider than the strip would show the same story entering on the right as it leaves on the left).
/// An unknown or zero width (before layout) never moves.
export function marqueeMoves(count: number, stripWidth: number | null): boolean {
  if (stripWidth === null || !Number.isFinite(stripWidth) || stripWidth <= 0) return false;
  return count >= 2 && (count - 1) * INTEL_CARD_W >= stripWidth;
}

/// React keys for the cards: the story's link, else its title and publish time, so a story keeps its key when the
/// 5-minute refetch adds a newer one in front (index keys would hand every card the next one's identity mid-crawl).
/// A story the feed happens to list twice gets a numbered key rather than a clash.
export function intelKeys(items: readonly IntelItem[]): string[] {
  const seen = new Map<string, number>();
  return items.map((n) => {
    const base = n.url ? `u:${n.url}` : `t:${n.title}|${n.publishedAt ?? ''}`;
    const k = seen.get(base) ?? 0;
    seen.set(base, k + 1);
    return k === 0 ? base : `${base}#${k}`;
  });
}

/// The strip's own width, kept current as the window resizes. null until it has been laid out.
function useWidth(ref: React.RefObject<HTMLElement | null>): number | null {
  const [w, setW] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setW(el.clientWidth || null);
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

type Props = { items: IntelItem[]; nowMs: number | null; minCols: number };

export function IntelStrip({ items, nowMs, minCols }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const moving = marqueeMoves(items.length, useWidth(ref));
  const keys = intelKeys(items);
  const cards = (copy: boolean) =>
    items.map((n, i) => <IntelCard key={copy ? `copy:${keys[i]}` : keys[i]} item={n} nowMs={nowMs} fixed={moving} copy={copy} />);

  // The hairline above the cards sits on an outer box, so the edge fade (a mask on the strip) never fades it.
  return (
    <div style={{ boxShadow: 'inset 0 1px 0 var(--line)' }}>
      <div
        ref={ref}
        className={moving ? 'mk-marquee' : undefined}
        // Keyboard focus turns the strip into a still row that focus scrolls (mako-shell.css). The browser leaves a card
        // that is partly on screen where it is, so bring the focused card's whole box in. Only for keyboard focus: a
        // mouse click or a tap leaves the crawl running and must not scroll it.
        onFocus={moving ? (e) => revealKeyboardFocus(e.target) : undefined}
        // When focus leaves the strip, the crawl starts again from its beginning, so put the scroll back to the start.
        onBlur={
          moving
            ? (e) => {
                if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
                // With reduced motion the row is scrolled by hand: leave it where the reader put it.
                if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
                e.currentTarget.scrollLeft = 0;
              }
            : undefined
        }
      >
        {moving ? (
          <div className="mk-marquee-track" style={{ '--mk-marquee-dur': `${marqueeDurationSec(items.length)}s` } as React.CSSProperties}>
            <ul className="mk-marquee-row">{cards(false)}</ul>
            <ul aria-hidden="true" className="mk-marquee-row mk-marquee-dup">
              {cards(true)}
            </ul>
          </div>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: `repeat(${Math.max(minCols, items.length)},minmax(0,1fr))` }}>
            {cards(false)}
          </ul>
        )}
      </div>
    </div>
  );
}

/// Scrolls the card holding `el` wholly into the strip, when `el` has keyboard focus (:focus-visible). A browser that
/// does not know :focus-visible also lacks the still-row rule keyed on it, so it does nothing there.
function revealKeyboardFocus(el: Element) {
  let keyboard = false;
  try {
    keyboard = el.matches(':focus-visible');
  } catch {
    return;
  }
  if (keyboard) el.closest('li')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}

const mono: React.CSSProperties = { fontFamily: 'var(--mako-font-mono)' };

function IntelCard({ item: n, nowMs, fixed, copy }: { item: IntelItem; nowMs: number | null; fixed: boolean; copy: boolean }) {
  const age = newsAge(n.publishedAt, n.time, nowMs ?? Number.NaN).long;
  return (
    <li
      className={n.url ? 'mk-row' : undefined}
      style={{ position: 'relative', padding: '14px 20px 18px', display: 'flex', flexDirection: 'column', gap: 8, boxShadow: 'inset -1px 0 0 var(--line)', boxSizing: 'border-box', ...(fixed ? { flex: 'none', width: INTEL_CARD_W } : null) }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, ...mono, fontSize: 11 }}>
        <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: CAT_STYLE[n.tag].bg }} />
        <span style={{ fontWeight: 700 }}>{n.tag}</span>
        <span style={{ color: 'var(--dim)' }}>{age}</span>
      </div>
      {n.url ? (
        <a
          href={n.url}
          target="_blank"
          rel="noopener noreferrer"
          tabIndex={copy ? -1 : undefined}
          className="mk-rowlink"
          style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.4, textWrap: 'pretty', color: 'inherit', textDecoration: 'none' }}
        >
          {n.title}
        </a>
      ) : (
        <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.4, textWrap: 'pretty' }}>{n.title}</div>
      )}
    </li>
  );
}
