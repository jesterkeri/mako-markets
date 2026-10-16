'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { newsAge, type IntelItem } from '@/lib/news-intel';
import { CAT_STYLE } from '@/lib/pool-list';

// Home's Market intel cards (Joshua, 2026-10-16): every story the feed has, moving slowly left in an endless loop
// once there are more than fit, paused under a fine pointer. The motion is one CSS animation on one track
// (mako-shell.css, `.mk-marquee`): transform only, linear, no JS loop. The list is drawn twice and the track slides by
// half its width, so the loop has no seam; the second copy is hidden from assistive tech and its links are out of the
// tab order, so each story is met once.
//
// Keyboard mode is React state, not a CSS selector. It starts only when focus ARRIVES on a card and that focus was not
// caused by a click or a tap (`focusFromPointer`): then the strip carries `data-kb`, which makes it a still row of one
// copy that scrolls, and every card focus reaches is scrolled wholly into view (again after a refetch moves it). It ends
// when focus leaves the strip, or a refetch removes the focused card, and the crawl starts again from its beginning. A key pressed while focus stays put changes nothing, so a story clicked
// with the mouse and then ArrowDown or Space to scroll the page never freezes the strip. With reduced motion the strip is
// always that still row (CSS), and is scrolled by hand.

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
/// A story the feed lists more than once gets a numbered key (`#1`, `#2`, ...). Collision-free by construction: every
/// `#` in a base key is doubled, so a base key's runs of `#` are all even, and a numbered key is the only kind that
/// carries an odd run (its single `#` before the count). Two bases that are equal get different counts; two that
/// differ stay different after doubling.
export function intelKeys(items: readonly IntelItem[]): string[] {
  const seen = new Map<string, number>();
  return items.map((n) => {
    const base = (n.url ? `u:${n.url}` : `t:${n.title}|${n.publishedAt ?? ''}`).replace(/#/g, '##');
    const k = seen.get(base) ?? 0;
    seen.set(base, k + 1);
    return k === 0 ? base : `${base}#${k}`;
  });
}

/// What the reader last did on the page, for telling a click from the keyboard when focus arrives on a card. Kept by
/// one set of window listeners in the capture phase (so no page handler can hide an event from them), shared by every
/// mounted strip. A pointer press records itself and its target at once. A key counts only if it is one that moves
/// focus (Tab, Shift+Tab, an arrow, with no Ctrl, Alt or Meta) AND focus really moved: while its keydown is being
/// handled the key is `pending` (focus that arrives then is the key's), and a task later it is recorded only if the
/// focused element changed. So Space, PageDown, Escape, a letter, or an ArrowDown that only scrolled the page, leave
/// the record as it was: a story clicked and then scrolled past with the arrows still counts as clicked when the reader
/// comes back to the window. A press is also used up by the first focus it does not explain: focus that arrives anywhere
/// on the page, away from the pressed card (a screen reader moving on to another story, or out of the strip), clears
/// it, so the same story focused again later by the keyboard or a screen reader is not taken for the old click. And a
/// press that brought no focus with it (a finger dragging the still row, a press the page cancelled) is dropped when it
/// ends: only a press that focused its card can later explain that card's focus (the return from the story's new tab).
type InputRecord = { last: 'keyboard' | 'pointer' | null; target: EventTarget | null };
const input: InputRecord & { pending: boolean; focused: boolean; down: boolean } = { last: null, target: null, pending: false, focused: false, down: false };
let listeners = 0;
let pendingFrom: Element | null = null;
function onKeyInput(e: KeyboardEvent) {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key !== 'Tab' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown' && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  // Keys pressed before the first one settles are judged together, from where focus was when the first was pressed,
  // and the first timer to run settles them all (a timer runs only after each keydown has moved focus or not).
  if (!input.pending) pendingFrom = document.activeElement;
  input.pending = true;
  setTimeout(() => {
    // A pointer press since then is newer input and has already replaced the record.
    if (!input.pending) return;
    input.pending = false;
    if (document.activeElement === pendingFrom) return;
    input.last = 'keyboard';
    input.target = null;
  }, 0);
}
function onPointerInput(e: Event) {
  input.pending = false;
  input.last = 'pointer';
  input.target = e.target;
  input.down = true;
  // A press on the card that already holds focus moves no focus (no focusin), yet it is the press that focus belongs
  // to, as when an open story is clicked again: it counts as having focused its card. Only an element inside a card
  // (an `li`) counts as holding it, never something that merely contains the strip.
  const held = document.activeElement;
  input.focused = held instanceof Element && held.closest('li') !== null && focusFromPointer(held);
}
function onFocusInput(e: FocusEvent) {
  if (input.last !== 'pointer' || !(e.target instanceof Node)) return;
  if (focusFromPointer(e.target)) {
    input.focused = true;
    return;
  }
  input.last = null;
  input.target = null;
}
// A touch tap runs pointerdown, touchstart, pointerup, touchend and only then mousedown (which focuses the link), so the
// tap's own press is dropped at touchend and recorded again by its mousedown.
function onPressEnd() {
  input.down = false;
  if (input.last !== 'pointer' || input.focused) return;
  input.last = null;
  input.target = null;
}
const POINTER_EVENTS = ['pointerdown', 'mousedown', 'touchstart'] as const;
// What ends a press. A release can also never reach the page: a native context menu can swallow the mouseup, a drag
// ends in dragend, and switching window mid-press takes the release elsewhere. So a drag's end, the window losing focus
// and the first pointer movement with no button held count as the end too, or a held press would stay "held" until the
// next one. Not `contextmenu` itself: on Linux and macOS it fires when the right button goes DOWN, mid-press.
const PRESS_END_EVENTS = ['pointerup', 'pointercancel', 'mouseup', 'touchend', 'touchcancel', 'dragend'] as const;
/// Calls `cb` on every press end until the returned function removes it. The window's own blur only: `blur` does not
/// bubble, so a listener on the window outside the capture phase sees no element's blur.
function onPressEnds(cb: () => void): () => void {
  const onBlur = (e: Event) => {
    if (e.target === window) cb();
  };
  const onMove = (e: PointerEvent) => {
    if (e.buttons === 0) cb();
  };
  for (const t of PRESS_END_EVENTS) window.addEventListener(t, cb, { capture: true, passive: true });
  window.addEventListener('pointermove', onMove, { capture: true, passive: true });
  window.addEventListener('blur', onBlur);
  return () => {
    for (const t of PRESS_END_EVENTS) window.removeEventListener(t, cb, true);
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('blur', onBlur);
  };
}
let stopPressEnds: (() => void) | null = null;

function useInputRecord() {
  useEffect(() => {
    if (listeners++ === 0) {
      window.addEventListener('keydown', onKeyInput, true);
      window.addEventListener('focusin', onFocusInput, true);
      for (const t of POINTER_EVENTS) window.addEventListener(t, onPointerInput, { capture: true, passive: true });
      stopPressEnds = onPressEnds(onPressEnd);
    }
    return () => {
      if (--listeners > 0) return;
      window.removeEventListener('keydown', onKeyInput, true);
      window.removeEventListener('focusin', onFocusInput, true);
      for (const t of POINTER_EVENTS) window.removeEventListener(t, onPointerInput, true);
      stopPressEnds?.();
      stopPressEnds = null;
      input.last = null;
      input.target = null;
      input.pending = false;
      input.focused = false;
      input.down = false;
    };
  }, []);
}

/// Whether focus arriving on `el` came from a click or a tap: the last input was a pointer press on `el`'s card (the
/// `li` around it; `el` itself when it has none) or inside it, and no focus-moving key is being handled. That covers
/// the focus a click gives a link, and the focus the browser gives the same link back when the reader returns to the
/// window after the story opened in a new tab (the press that opened it was on that link). A press anywhere else, even
/// on an element that holds the strip (blank page space is <html>, which holds everything), says nothing about focus
/// that arrives later: focus with no pointer press on its card behind it (Tab, an arrow key that moved focus, a screen
/// reader moving focus, a script calling focus()) is the keyboard's.
export function focusFromPointer(el: Node, rec: InputRecord & { pending?: boolean } = input): boolean {
  if (rec.pending || rec.last !== 'pointer') return false;
  const t = rec.target;
  if (!(t instanceof Node)) return true;
  const card = el instanceof Element ? (el.closest('li') ?? el) : el;
  return card.contains(t);
}

/// Scrolls the strip so the card holding `el` is wholly inside it (the browser leaves a card that is partly on screen
/// where it is). Horizontal only, and instant: the page itself is the browser's to scroll.
function revealCard(strip: HTMLElement, el: Element) {
  const card = el.closest('li');
  if (!card || !strip.contains(card)) return;
  const s = strip.getBoundingClientRect();
  const c = card.getBoundingClientRect();
  if (c.left < s.left) strip.scrollLeft -= s.left - c.left;
  else if (c.right > s.right) strip.scrollLeft += Math.min(c.right - s.right, c.left - s.left);
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
  useInputRecord();
  // Keyboard mode (see the header). `reveal` names the element keyboard focus last arrived on; each arrival is a new
  // object, so the layout effect below runs once per arrival, after `data-kb` has made the still row.
  const [kb, setKb] = useState(false);
  const [reveal, setReveal] = useState<{ el: Element } | null>(null);
  // A strip that stops moving (the window grew, the feed shrank) leaves keyboard mode, so it never comes back still.
  if (!moving && (kb || reveal)) {
    setKb(false);
    setReveal(null);
  }
  useLayoutEffect(() => {
    const strip = ref.current;
    if (kb && reveal && strip && document.activeElement === reveal.el) revealCard(strip, reveal.el);
  }, [kb, reveal]);
  // Leaving keyboard mode: the crawl starts again from its beginning, so the scroll goes back to the start. With
  // reduced motion the row is scrolled by hand, so it stays where the reader put it.
  const leaveKb = (strip: HTMLElement) => {
    setKb(false);
    setReveal(null);
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    strip.scrollLeft = 0;
  };
  // Keyboard mode is checked again whenever the 5-minute refetch changes the stories, not only when focus events reach
  // the strip, because that is the one way the cards change under a focused one. If focus is no longer inside the strip
  // (the refetch dropped the focused story: React removed its card, focus fell to <body>, and no blur reached the
  // strip), the mode ends just as a blur would end it. If focus is still inside (a newer story in front moves every
  // card a card width right), the focused card is brought wholly into view again. Only on a change of stories, so a
  // reader who scrolled the still row by hand is not pulled back by an unrelated render (the age labels re-render).
  const storiesKey = keys.join('\n');
  const shownStories = useRef(storiesKey);
  useLayoutEffect(() => {
    if (shownStories.current === storiesKey) return;
    shownStories.current = storiesKey;
    const strip = ref.current;
    if (!kb || !strip) return;
    const focused = document.activeElement;
    if (focused && strip.contains(focused)) revealCard(strip, focused);
    else leaveKb(strip);
  });

  const cards = (copy: boolean) =>
    items.map((n, i) => <IntelCard key={copy ? `copy:${keys[i]}` : keys[i]} item={n} nowMs={nowMs} fixed={moving} copy={copy} />);

  // The hairline above the cards sits on an outer box, so the edge fade (a mask on the strip) never fades it.
  return (
    <div style={{ boxShadow: 'inset 0 1px 0 var(--line)' }}>
      <div
        ref={ref}
        className={moving ? 'mk-marquee' : undefined}
        data-kb={moving && kb ? '' : undefined}
        // Focus arriving on a card: from the keyboard it starts (or continues) keyboard mode and brings the card into
        // view. From a click or a tap it changes nothing: the crawl keeps running (paused only while a fine pointer is
        // over it), and in keyboard mode the still row stays put, so the row never shifts between press and release.
        onFocus={
          moving
            ? (e) => {
                if (focusFromPointer(e.target)) return;
                setKb(true);
                setReveal({ el: e.target });
              }
            : undefined
        }
        // Focus leaving the strip ends keyboard mode, and the crawl starts again from its beginning, so the scroll goes
        // back to the start. The window itself losing focus (the story opened in a new tab) is not focus leaving: the
        // focused card stays the document's active element, and the mode holds for the reader's return.
        onBlur={
          moving
            ? (e) => {
                const strip = e.currentTarget;
                const to = e.relatedTarget as Node | null;
                if (to ? strip.contains(to) : strip.contains(document.activeElement)) return;
                // A press held on a card with nothing focusable in it (a story with no link) sends focus to <body> at
                // the press. The row must not move before the release, so the mode ends only once the press does,
                // and only if focus is still outside the strip then.
                if (!to && input.down && input.target instanceof Node && strip.contains(input.target)) {
                  const stop = onPressEnds(() => {
                    stop();
                    setTimeout(() => {
                      if (!strip.contains(document.activeElement)) leaveKb(strip);
                    }, 0);
                  });
                  return;
                }
                leaveKb(strip);
              }
            : undefined
        }
      >
        {/* A refetch that changes the story count changes this duration mid-loop, and the crawl jumps once to where the
            elapsed time falls in the new loop. Accepted, not corrected: a refetch moves the cards under the crawl anyway
            (a newer story in front shifts every card one width), the feed is capped at 30 so the count rarely changes,
            and keeping the pixel position would mean driving the animation from JS for a once-in-5-minutes event. */}
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
