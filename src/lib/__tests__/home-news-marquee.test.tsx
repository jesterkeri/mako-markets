// Home's Market intel cards move (Joshua, 2026-10-16): every story the feed has crawls slowly left in an endless loop
// once the stories overflow the strip, paused under a fine pointer, a still row of one copy while a card has KEYBOARD
// focus (never a click or tap), and still with reduced motion. The list is drawn twice for a seamless loop; assistive
// tech and the keyboard meet each story once. Too few stories to overflow the strip never move (no story on screen
// twice). The motion itself is CSS, so its rules are read from the shipped stylesheet; what only a real browser can
// show (layout, focus scrolling, animation state) is in src/browser-tests (local only, `pnpm test:browser`).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import * as React from 'react';

import type { IntelItem } from '@/lib/news-intel';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('@/components/rounds/HomeRounds', () => ({ HomeRoundsBand: () => null }));

const { IntelStrip, INTEL_CARD_W, INTEL_PX_PER_SEC, intelKeys, marqueeDurationSec, marqueeMoves } = await import('@/app/_home/IntelStrip');
const { HomeDesktop } = await import('@/app/_home/HomeDesktop');

const NOW = Date.parse('2026-10-16T12:00:00Z');
const TAGS = ['CRYPTO', 'FOOTBALL', 'NBA'] as const;
const stories = (n: number): IntelItem[] =>
  Array.from({ length: n }, (_, i) => ({
    tag: TAGS[i % 3],
    title: `Story ${i + 1}`,
    time: 'RECENT',
    // Every third story has no link (the feed's game results), like the real feed.
    url: i % 3 === 2 ? undefined : `https://example.com/story-${i + 1}`,
    publishedAt: new Date(NOW - (i + 1) * 60_000).toISOString(),
  }));

const TITLES = (n: number) => Array.from({ length: n }, (_, i) => `Story ${i + 1}`);
const titlesOf = (els: HTMLElement[]) => els.map((el) => el.textContent?.match(/Story \d+/)?.[0]);

/// The strip's laid-out width. happy-dom does no layout, so clientWidth is pinned per test.
let stripWidth = 0;
const realClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
beforeEach(() => {
  stripWidth = 0;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => stripWidth });
});
afterEach(() => {
  cleanup();
  if (realClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', realClientWidth);
});

function strip(n: number, width: number) {
  stripWidth = width;
  return render(<IntelStrip items={stories(n)} nowMs={NOW} minCols={4} />).container;
}

describe('a story with no link (r12 design)', () => {
  it('its card takes focus on a press but never from Tab (tabIndex -1); the hidden copy is never focusable; linked cards stay as they were', () => {
    const c = strip(12, 1216);
    const cards = (sel: string) => [...c.querySelectorAll<HTMLLIElement>(`${sel} li`)];
    const shown = cards('.mk-marquee ul:not([aria-hidden])');
    const copy = cards('.mk-marquee ul[aria-hidden]');
    expect(shown).toHaveLength(12);
    expect(copy).toHaveLength(12);
    for (const li of shown) expect(li.getAttribute('tabindex'), li.textContent!).toBe(li.querySelector('a') ? null : '-1');
    for (const li of copy) expect(li.getAttribute('tabindex'), li.textContent!).toBeNull();
    expect(shown.filter((li) => !li.querySelector('a')).length).toBe(4);
  });
  it('a still strip (no crawl) gives link-less cards the same press focus', () => {
    const c = strip(4, 1216);
    const li = [...c.querySelectorAll<HTMLLIElement>('li')].filter((x) => !x.querySelector('a'));
    expect(li.map((x) => x.getAttribute('tabindex'))).toEqual(['-1']);
  });
});

describe('when the strip moves', () => {
  it('moves only when one copy of the list is at least a card wider than the strip', () => {
    // A 1280 px window: the strip is about 1216 px wide, so 4 stories (1280 px) would show a story twice at once.
    expect(marqueeMoves(4, 1216)).toBe(false);
    expect(marqueeMoves(5, 1216)).toBe(true);
    // The widest frame (1920 px less its gutters): 6 cards (1920 px, 5 x 320 = 1600 < 1824) still fit.
    expect(marqueeMoves(6, 1824)).toBe(false);
    expect(marqueeMoves(7, 1824)).toBe(true);
    // Nothing moves before layout, at zero width, or with one story.
    expect(marqueeMoves(12, null)).toBe(false);
    expect(marqueeMoves(12, 0)).toBe(false);
    expect(marqueeMoves(1, 100)).toBe(false);
    expect(marqueeMoves(0, 100)).toBe(false);
  });

  it('keeps one speed however many stories there are: duration = cards x card width / 40 px a second', () => {
    expect(INTEL_PX_PER_SEC).toBe(40);
    expect(marqueeDurationSec(5)).toBe((5 * INTEL_CARD_W) / 40);
    expect(marqueeDurationSec(12)).toBe(96);
    expect(marqueeDurationSec(30) / 30).toBe(marqueeDurationSec(5) / 5);
  });
});

describe('IntelStrip', () => {
  it('with 12 stories: every one shows, the track loops at 40 px/s, and each story is met once by assistive tech and the keyboard', () => {
    const c = strip(12, 1216);
    const viewport = c.querySelector('.mk-marquee') as HTMLElement;
    expect(viewport).toBeTruthy();
    const track = viewport.querySelector('.mk-marquee-track') as HTMLElement;
    expect(track.style.getPropertyValue('--mk-marquee-dur')).toBe('96s');

    const [first, dup, ...rest] = Array.from(track.children) as HTMLElement[];
    expect(rest).toEqual([]);
    expect(first.tagName).toBe('UL');
    expect(first.getAttribute('aria-hidden')).toBeNull();
    expect(dup.getAttribute('aria-hidden')).toBe('true');
    expect(dup.classList.contains('mk-marquee-dup')).toBe(true);
    expect(first.querySelectorAll('li')).toHaveLength(12);
    expect(dup.querySelectorAll('li')).toHaveLength(12);
    // Both rows take their layout from the stylesheet class; no inline display that would beat the rules hiding the copy.
    for (const ul of [first, dup]) {
      expect(ul.classList.contains('mk-marquee-row')).toBe(true);
      expect(ul.style.display).toBe('');
    }

    // The copy's links are out of the tab order; the first copy's are not.
    const dupLinks = Array.from(dup.querySelectorAll('a'));
    expect(dupLinks).toHaveLength(8);
    for (const a of dupLinks) expect(a.getAttribute('tabindex')).toBe('-1');
    for (const a of Array.from(first.querySelectorAll('a'))) expect(a.hasAttribute('tabindex')).toBe(false);

    // Assistive tech (role queries skip aria-hidden subtrees) meets every story once, all twelve of them, in order.
    expect(titlesOf(screen.getAllByRole('listitem'))).toEqual(TITLES(12));
    expect(screen.getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(
      stories(12).flatMap((s) => (s.url ? [s.url] : [])),
    );
    // Each card is a fixed width, so the duration's arithmetic matches what is drawn.
    expect((first.querySelector('li') as HTMLElement).style.width).toBe(`${INTEL_CARD_W}px`);
  });

  it('when keyboard focus leaves the moving strip, its scroll goes back to the start (no gap in the loop)', () => {
    const c = strip(12, 1216);
    const viewport = c.querySelector('.mk-marquee') as HTMLElement;
    const [a, b] = Array.from(viewport.querySelectorAll('ul:not([aria-hidden]) a')) as HTMLElement[];
    viewport.scrollLeft = 300;
    // Focus moving between cards keeps the scroll that brought the card into view.
    fireEvent.blur(a, { relatedTarget: b });
    expect(viewport.scrollLeft).toBe(300);
    fireEvent.blur(b, { relatedTarget: document.body });
    expect(viewport.scrollLeft).toBe(0);
  });

  it('a refetch that adds a newer story in front keeps every existing card (keyed by story, not by position)', () => {
    stripWidth = 1216;
    const before = stories(12);
    const { container, rerender } = render(<IntelStrip items={before} nowMs={NOW} minCols={4} />);
    const cardOf = (title: string) =>
      Array.from(container.querySelectorAll('.mk-marquee-track > ul:not([aria-hidden]) li')).find((li) => li.textContent?.match(/Story \d+/)?.[0] === title);
    const copyCardOf = (title: string) =>
      Array.from(container.querySelectorAll('.mk-marquee-dup li')).find((li) => li.textContent?.match(/Story \d+/)?.[0] === title);
    const s1 = cardOf('Story 1');
    const s7 = cardOf('Story 7');
    const c1 = copyCardOf('Story 1');
    expect(s1 && s7 && c1).toBeTruthy();
    const newer: IntelItem = { tag: 'CRYPTO', title: 'Story 0', time: 'RECENT', url: 'https://example.com/story-0', publishedAt: new Date(NOW).toISOString() };
    rerender(<IntelStrip items={[newer, ...before]} nowMs={NOW} minCols={4} />);
    expect(cardOf('Story 1')).toBe(s1);
    expect(cardOf('Story 7')).toBe(s7);
    expect(copyCardOf('Story 1')).toBe(c1);
  });

  it('keys each story by its link, else its title and publish time, and a repeated story never clashes', () => {
    const a: IntelItem = { tag: 'NBA', title: 'Final', time: '', publishedAt: '2026-10-16T10:00:00Z' };
    const b: IntelItem = { tag: 'CRYPTO', title: 'Linked', time: '', url: 'https://example.com/x' };
    expect(intelKeys([a, b])).toEqual(['t:Final|2026-10-16T10:00:00Z', 'u:https://example.com/x']);
    expect(intelKeys([b, a, b])).toEqual(['u:https://example.com/x', 't:Final|2026-10-16T10:00:00Z', 'u:https://example.com/x#1']);
    // Same title, different time: two stories.
    expect(new Set(intelKeys([a, { ...a, publishedAt: '2026-10-16T11:00:00Z' }])).size).toBe(2);
    // A `#` in a link is doubled, so a link with the fragment #1 is never the second listing of the same link.
    const x1: IntelItem = { ...b, url: 'https://example.com/x#1' };
    expect(intelKeys([b, b, x1])).toEqual(['u:https://example.com/x', 'u:https://example.com/x#1', 'u:https://example.com/x##1']);
    expect(intelKeys([x1, b, b, x1])).toEqual(['u:https://example.com/x##1', 'u:https://example.com/x', 'u:https://example.com/x#1', 'u:https://example.com/x##1#1']);
  });

  it('never hands two cards one key, whatever the links, titles and times spell (exhaustive over a small alphabet)', () => {
    // Every list of up to 4 stories whose links (or titles) are drawn from strings that contain `#`, digits and `|`.
    const parts = ['a', 'a#1', 'a#1#1', 'a##1', '#', '#1', '1', 'a|', '|'];
    const pool: IntelItem[] = [
      ...parts.map((p) => ({ tag: 'CRYPTO' as const, title: 't', time: '', url: p })),
      ...parts.map((p) => ({ tag: 'NBA' as const, title: p, time: '', publishedAt: p })),
      ...parts.map((p) => ({ tag: 'NBA' as const, title: 'x', time: '', publishedAt: p })),
    ];
    let lists = 0;
    for (const i of pool)
      for (const j of pool)
        for (const k of pool) {
          const keys = intelKeys([i, j, k, i]);
          lists++;
          expect(new Set(keys).size).toBe(4);
        }
    expect(lists).toBe(pool.length ** 3);
  });

  it.each([1, 3, 4])('with %i stories on a 1216 px strip: a still row, no copy, nothing hidden', (n) => {
    const c = strip(n, 1216);
    expect(c.querySelector('.mk-marquee')).toBeNull();
    expect(c.querySelector('.mk-marquee-track')).toBeNull();
    expect(c.querySelector('[aria-hidden="true"] li')).toBeNull();
    expect(c.querySelectorAll('li')).toHaveLength(n);
    // Today's four-across grid, one column a story past four.
    expect((c.querySelector('ul') as HTMLElement).style.gridTemplateColumns).toBe('repeat(4,minmax(0,1fr))');
  });

  it('before layout (no width yet) never moves, even with many stories', () => {
    const c = strip(12, 0);
    expect(c.querySelector('.mk-marquee')).toBeNull();
    expect(c.querySelectorAll('li')).toHaveLength(12);
  });

  it('on a wide strip where the stories fit, they share the row without moving', () => {
    const c = strip(6, 1824);
    expect(c.querySelector('.mk-marquee')).toBeNull();
    expect((c.querySelector('ul') as HTMLElement).style.gridTemplateColumns).toBe('repeat(6,minmax(0,1fr))');
  });
});

describe('keyboard mode is React state, entered only by focus the keyboard moved', () => {
  const setup = () => {
    const c = strip(12, 1216);
    const viewport = c.querySelector('.mk-marquee') as HTMLElement;
    const links = Array.from(viewport.querySelectorAll('ul:not([aria-hidden]) a')) as HTMLElement[];
    return { viewport, links };
  };
  const key = (k: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(window, { key: k, ...init });

  it('Tab then focus on a card: data-kb on; focus leaving the strip: off, scroll back at 0', () => {
    const { viewport, links } = setup();
    key('Tab');
    fireEvent.focus(links[0]);
    expect(viewport.hasAttribute('data-kb')).toBe(true);
    viewport.scrollLeft = 640;
    // Moving between cards keeps the mode and the scroll.
    key('Tab');
    fireEvent.blur(links[0], { relatedTarget: links[1] });
    fireEvent.focus(links[1], { relatedTarget: links[0] });
    expect(viewport.hasAttribute('data-kb')).toBe(true);
    expect(viewport.scrollLeft).toBe(640);
    fireEvent.blur(links[1], { relatedTarget: document.body });
    expect(viewport.hasAttribute('data-kb')).toBe(false);
    expect(viewport.scrollLeft).toBe(0);
  });

  it.each(['pointerdown', 'mousedown', 'touchstart'])('focus that follows a %s on the card never enters the mode', (ev) => {
    const { viewport, links } = setup();
    key('Tab');
    fireEvent(links[2], new Event(ev, { bubbles: true }));
    fireEvent.focus(links[2]);
    expect(viewport.hasAttribute('data-kb')).toBe(false);
  });

  it.each([' ', 'ArrowDown', 'PageDown', 'Escape', 'a', 'Shift', 'Enter'])('a click, then %j with focus unchanged: still no mode', (k) => {
    const { viewport, links } = setup();
    fireEvent.mouseDown(links[2]);
    fireEvent.focus(links[2]);
    key(k);
    expect(viewport.hasAttribute('data-kb')).toBe(false);
  });

  it('a click, then Tab to the next card: the mode starts on that arrival', () => {
    const { viewport, links } = setup();
    fireEvent.mouseDown(links[2]);
    fireEvent.focus(links[2]);
    key('Tab');
    fireEvent.blur(links[2], { relatedTarget: links[3] });
    fireEvent.focus(links[3], { relatedTarget: links[2] });
    expect(viewport.hasAttribute('data-kb')).toBe(true);
  });

  it('only keys that move focus count: Ctrl/Alt/Meta+Tab and Space do not', () => {
    const { viewport, links } = setup();
    for (const init of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
      fireEvent.mouseDown(links[2]);
      key('Tab', init);
      fireEvent.focus(links[2]);
      expect(viewport.hasAttribute('data-kb')).toBe(false);
    }
    fireEvent.mouseDown(links[2]);
    key(' ');
    fireEvent.focus(links[2]);
    expect(viewport.hasAttribute('data-kb')).toBe(false);
  });

  it('an arrow key that moves no focus is forgotten: focus coming back to a clicked card later is still the click', async () => {
    const { viewport, links } = setup();
    // A click: the press, then the focus it gives the link.
    fireEvent.mouseDown(links[2]);
    links[2].focus();
    expect(viewport.hasAttribute('data-kb')).toBe(false);
    key('ArrowDown');
    // A task later the key is settled: focus did not move, so the record stays the click.
    await new Promise((r) => setTimeout(r, 5));
    fireEvent.blur(links[2], { relatedTarget: null });
    fireEvent.focus(links[2]);
    expect(viewport.hasAttribute('data-kb')).toBe(false);
  });

  it('an arrow key that does move focus is remembered: focus coming back later is the keyboard', async () => {
    const { viewport, links } = setup();
    fireEvent.mouseDown(links[2]);
    links[2].focus();
    expect(viewport.hasAttribute('data-kb')).toBe(false);
    key('ArrowRight');
    links[3].focus();
    await new Promise((r) => setTimeout(r, 5));
    expect(viewport.hasAttribute('data-kb')).toBe(true);
    // The window goes and comes back; nothing pending now, and the last input is that key.
    fireEvent.focus(links[3]);
    expect(viewport.hasAttribute('data-kb')).toBe(true);
  });

  it('a click while in the mode keeps the still row as it is (no shift under the pointer)', () => {
    const { viewport, links } = setup();
    key('Tab');
    fireEvent.focus(links[0]);
    viewport.scrollLeft = 320;
    fireEvent.mouseDown(links[1]);
    fireEvent.blur(links[0], { relatedTarget: links[1] });
    fireEvent.focus(links[1], { relatedTarget: links[0] });
    expect(viewport.hasAttribute('data-kb')).toBe(true);
    expect(viewport.scrollLeft).toBe(320);
  });

  it('a strip that stops moving leaves the mode, so it never comes back still when it moves again', () => {
    stripWidth = 1216;
    const { container, rerender } = render(<IntelStrip items={stories(12)} nowMs={NOW} minCols={4} />);
    const link = container.querySelector('.mk-marquee ul:not([aria-hidden]) a') as HTMLElement;
    key('Tab');
    fireEvent.focus(link);
    expect((container.querySelector('.mk-marquee') as HTMLElement).hasAttribute('data-kb')).toBe(true);
    // The feed shrinks to 3 stories (they fit, nothing moves), then grows again with focus elsewhere.
    rerender(<IntelStrip items={stories(3)} nowMs={NOW} minCols={4} />);
    expect(container.querySelector('.mk-marquee')).toBeNull();
    rerender(<IntelStrip items={stories(12)} nowMs={NOW} minCols={4} />);
    expect((container.querySelector('.mk-marquee') as HTMLElement).hasAttribute('data-kb')).toBe(false);
  });

  it('focusFromPointer: a press on the card (the element, inside it, or its li); never outside the card or after a focus-moving key', async () => {
    const { focusFromPointer } = await import('@/app/_home/IntelStrip');
    const ul = document.createElement('ul');
    const li = document.createElement('li');
    const a = document.createElement('a');
    const span = document.createElement('span');
    a.appendChild(span);
    li.appendChild(a);
    ul.appendChild(li);
    const other = document.createElement('div');
    expect(focusFromPointer(a, { last: 'pointer', target: a })).toBe(true);
    expect(focusFromPointer(a, { last: 'pointer', target: span })).toBe(true);
    expect(focusFromPointer(a, { last: 'pointer', target: li })).toBe(true);
    expect(focusFromPointer(a, { last: 'pointer', target: other })).toBe(false);
    // A press on something that merely holds the card (the row, the strip, blank page space = <html>) says nothing about
    // focus that arrives later (a screen reader moving focus): that focus is the keyboard's.
    expect(focusFromPointer(a, { last: 'pointer', target: ul })).toBe(false);
    expect(focusFromPointer(a, { last: 'pointer', target: document.documentElement })).toBe(false);
    expect(focusFromPointer(a, { last: 'keyboard', target: null })).toBe(false);
    expect(focusFromPointer(a, { last: null, target: null })).toBe(false);
    // While a focus-moving key is being handled, the focus it brings is the key's, whatever came before.
    expect(focusFromPointer(a, { last: 'pointer', target: a, pending: true })).toBe(false);
  });
});

describe('Home Market intel', () => {
  const home = (news: React.ComponentProps<typeof HomeDesktop>['news']) =>
    render(
      <HomeDesktop pools={{ status: 'loading' }} mako={{ status: 'loading' }} filter="ALL" setFilter={() => {}} labelsOf={() => ({ yes: 'YES', no: 'NO' })} retry={() => {}} news={news} nowMs={NOW} />,
    );

  it('shows more than four stories when the feed has more, each once for assistive tech', () => {
    stripWidth = 1216;
    home({ status: 'ready', items: stories(12) });
    const intel = screen.getByRole('region', { name: 'Market intel' });
    expect(titlesOf(within(intel).getAllByRole('listitem'))).toEqual(TITLES(12));
    expect(within(intel).getByRole('link', { name: 'All news →' }).getAttribute('href')).toBe('/news');
    expect(intel.querySelector('.mk-marquee')).toBeTruthy();
  });

  it('keeps the honest unavailable state (no strip at all)', () => {
    stripWidth = 1216;
    home({ status: 'unavailable' });
    const intel = screen.getByRole('region', { name: 'Market intel' });
    expect(within(intel).getByText('News is unavailable right now.')).toBeTruthy();
    expect(intel.querySelector('.mk-marquee')).toBeNull();
    expect(intel.querySelector('li')).toBeNull();
  });

  it('keeps the four loading skeletons, still', () => {
    stripWidth = 1216;
    home({ status: 'loading' });
    const busy = screen.getByLabelText('Loading news');
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(busy.querySelectorAll('li')).toHaveLength(4);
    expect(document.querySelector('.mk-marquee')).toBeNull();
  });
});

describe('the shipped CSS (mako-shell.css)', () => {
  const css = readFileSync(join(__dirname, '../../app/mako-shell.css'), 'utf8');
  const marquee = css.slice(css.indexOf('.mk-marquee {'), css.indexOf('.mk-marquee-dup {') + 200);
  /// The body of `@media <query> { ... }` that contains `needle`, braces balanced.
  const mediaWith = (query: string, needle: string) => {
    let from = 0;
    for (;;) {
      const at = css.indexOf(`@media ${query}`, from);
      if (at < 0) return '';
      let depth = 0;
      let i = css.indexOf('{', at);
      const start = i;
      for (; i < css.length; i++) {
        if (css[i] === '{') depth++;
        else if (css[i] === '}' && --depth === 0) break;
      }
      const body = css.slice(start + 1, i);
      if (body.includes(needle)) return body;
      from = i;
    }
  };

  it('animates only transform, linearly and forever, from 0 to -50% on the track', () => {
    const kf = css.slice(css.indexOf('@keyframes mkMarquee'), css.indexOf('@keyframes mkMarquee') + 160);
    expect(kf).toMatch(/from\s*\{\s*transform:\s*translateX\(0\);?\s*\}/);
    expect(kf).toMatch(/to\s*\{\s*transform:\s*translateX\(-50%\);?\s*\}/);
    const track = css.match(/\.mk-marquee-track\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(track).toMatch(/animation:\s*mkMarquee var\(--mk-marquee-dur[^)]*\) linear infinite/);
    expect(track).toMatch(/will-change:\s*transform/);
  });

  it('pauses under a fine pointer only', () => {
    const hover = mediaWith('(hover: hover) and (pointer: fine)', '.mk-marquee:hover');
    expect(hover).toMatch(/\.mk-marquee:hover \.mk-marquee-track\s*\{\s*animation-play-state:\s*paused/);
    // Never an ungated hover pause (touch taps would stick it).
    expect(css.replace(hover, '')).not.toMatch(/\.mk-marquee:hover/);
  });

  it('keyboard mode (the data-kb attribute IntelStrip sets) makes a still row of one copy, with no :has() or :focus-visible', () => {
    // :focus-within would also match a link focused by a mouse click or a touch tap and stick the strip; :has() is
    // missing in older browsers (Firefox ESR 115), and :focus-visible turns on for a clicked link at the next key press.
    expect(css).not.toMatch(/\.mk-marquee[^{]*:focus-within/);
    expect(css).not.toMatch(/\.mk-marquee[^{]*:has\(/);
    expect(css).not.toMatch(/\.mk-marquee[^{]*:focus-visible/);
    expect(css).toMatch(/\.mk-marquee\[data-kb\]\s*\{[^}]*overflow-x:\s*auto/);
    expect(css).toMatch(/\.mk-marquee\[data-kb\]\s*\{[^}]*[^-]mask-image:\s*none/);
    expect(css).toMatch(/\.mk-marquee\[data-kb\] \.mk-marquee-track\s*\{[^}]*animation:\s*none/);
    expect(css).toMatch(/\.mk-marquee\[data-kb\] \.mk-marquee-track\s*\{[^}]*transform:\s*none/);
    expect(css).toMatch(/\.mk-marquee\[data-kb\] \.mk-marquee-dup\s*\{\s*display:\s*none/);
  });

  it('with reduced motion: no movement, no copy, a row scrolled by hand', () => {
    const reduced = mediaWith('(prefers-reduced-motion: reduce)', '.mk-marquee');
    expect(reduced).toMatch(/\.mk-marquee-track\s*\{[^}]*animation:\s*none/);
    expect(reduced).toMatch(/\.mk-marquee-track\s*\{[^}]*transform:\s*none/);
    expect(reduced).toMatch(/\.mk-marquee \.mk-marquee-dup\s*\{\s*display:\s*none/);
    expect(reduced).toMatch(/\.mk-marquee\s*\{[^}]*overflow-x:\s*auto/);
    expect(reduced).toMatch(/\.mk-marquee\s*\{[^}]*mask-image:\s*none/);
  });

  it('lays the rows out in the stylesheet, so the rules that hide the copy can win', () => {
    expect(css).toMatch(/\.mk-marquee-row\s*\{[^}]*display:\s*flex/);
  });

  it('fades the edges with a mask from a theme token, never a hard-coded colour', () => {
    expect(marquee).toMatch(/[^-]mask-image:\s*linear-gradient\(to right, transparent, var\(--mako-canvas-fg\)/);
    expect(marquee).toMatch(/-webkit-mask-image:/);
    expect(marquee).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
  });
});
