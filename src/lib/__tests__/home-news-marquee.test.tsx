// Home's Market intel cards move (Joshua, 2026-10-16): every story the feed has crawls slowly left in an endless loop
// once the stories overflow the strip, paused under the pointer and while a card has keyboard focus, and still with
// reduced motion. The list is drawn twice for a seamless loop; assistive tech and the keyboard meet each story once.
// Too few stories to overflow the strip never move (no story on screen twice). The motion itself is CSS, so its rules
// are read from the shipped stylesheet.

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

const { IntelStrip, INTEL_CARD_W, INTEL_PX_PER_SEC, marqueeDurationSec, marqueeMoves } = await import('@/app/_home/IntelStrip');
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

  it('pauses under a fine pointer only, and whenever a card has focus', () => {
    const hover = mediaWith('(hover: hover) and (pointer: fine)', '.mk-marquee:hover');
    expect(hover).toMatch(/\.mk-marquee:hover \.mk-marquee-track\s*\{\s*animation-play-state:\s*paused/);
    // Never an ungated hover pause (touch taps would stick it).
    expect(css.replace(hover, '')).not.toMatch(/\.mk-marquee:hover/);
    expect(css).toMatch(/\.mk-marquee:focus-within \.mk-marquee-track\s*\{\s*animation-play-state:\s*paused/);
  });

  it('with reduced motion: no movement, no copy, a row scrolled by hand', () => {
    const reduced = mediaWith('(prefers-reduced-motion: reduce)', '.mk-marquee');
    expect(reduced).toMatch(/\.mk-marquee-track\s*\{[^}]*animation:\s*none/);
    expect(reduced).toMatch(/\.mk-marquee-track\s*\{[^}]*transform:\s*none/);
    expect(reduced).toMatch(/\.mk-marquee-dup\s*\{\s*display:\s*none/);
    expect(reduced).toMatch(/\.mk-marquee\s*\{[^}]*overflow-x:\s*auto/);
    expect(reduced).toMatch(/\.mk-marquee\s*\{[^}]*mask-image:\s*none/);
  });

  it('fades the edges with a mask from a theme token, never a hard-coded colour', () => {
    expect(marquee).toMatch(/[^-]mask-image:\s*linear-gradient\(to right, transparent, var\(--mako-canvas-fg\)/);
    expect(marquee).toMatch(/-webkit-mask-image:/);
    expect(marquee).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
  });
});
