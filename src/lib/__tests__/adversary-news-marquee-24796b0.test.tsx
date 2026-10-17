// Adversary on feat/news-marquee@24796b0 (Home Market intel crawl). Spec (owner, 2026-10-16): "Reduced motion:
// nothing moves; a static row the user can scroll by hand", and the duplicate copy used for the loop is hidden.
// IntelStrip's own header says "With reduced motion the second copy is not drawn".
//
// The copy's <ul> carries an inline `display: flex` (rowList), and the reduced-motion rule that should hide it is a
// plain stylesheet rule (`.mk-marquee-dup { display: none }`, mako-shell.css). An inline declaration beats any
// non-!important stylesheet rule, so with reduced motion the copy is still laid out: the hand-scrolled row runs
// through every story and then through all of them again. Verified in Chromium 1243 (headless) with
// reducedMotion 'reduce': `.mk-marquee-dup` computed display 'flex', strip scrollWidth 19200 for 30 stories
// (2 x 30 x 320), not 9600.
//
// happy-dom has no prefers-reduced-motion, so the reduced-motion block of the shipped stylesheet is applied
// unconditionally here (its media query swapped for `all`), and matchMedia reports reduce, so a fix that stops
// drawing the copy from script passes too.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import * as React from 'react';

import type { IntelItem } from '@/lib/news-intel';

const { IntelStrip } = await import('@/app/_home/IntelStrip');

const TAGS = ['CRYPTO', 'FOOTBALL', 'NBA'] as const;
const stories = (n: number): IntelItem[] =>
  Array.from({ length: n }, (_, i) => ({ tag: TAGS[i % 3], title: `Story ${i + 1}`, time: 'RECENT', url: `https://example.com/story-${i + 1}` }));

const realClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
let style: HTMLStyleElement | null = null;

beforeEach(() => {
  // The strip at a 1280 px window (1216 px less the frame's gutters), where 30 stories move.
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1216 });
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: /prefers-reduced-motion:\s*reduce/.test(q),
    media: q,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
  const css = readFileSync(join(__dirname, '../../app/mako-shell.css'), 'utf8');
  const block = css.slice(css.indexOf('.mk-marquee {'), css.indexOf('/* Pressed-state tint'));
  style = document.createElement('style');
  style.textContent = block.replace('@media (prefers-reduced-motion: reduce)', '@media all');
  document.head.appendChild(style);
});
afterEach(() => {
  cleanup();
  style?.remove();
  vi.unstubAllGlobals();
  if (realClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', realClientWidth);
});

const shown = (el: Element): boolean => {
  for (let e: Element | null = el; e; e = e.parentElement) if (getComputedStyle(e).display === 'none') return false;
  return true;
};

describe('reduced motion (adversary, 24796b0)', () => {
  it('draws each story once in the hand-scrolled row: the loop copy is not laid out', () => {
    const { container } = render(<IntelStrip items={stories(30)} nowMs={Date.parse('2026-10-16T12:00:00Z')} minCols={4} />);
    // Sanity: the reduced-motion rules really are in force for this render.
    const track = container.querySelector('.mk-marquee-track') as HTMLElement | null;
    if (track) expect(getComputedStyle(track).animationName === 'none' || getComputedStyle(track).animation.startsWith('none')).toBe(true);

    const dup = container.querySelector('.mk-marquee-dup');
    const dupShown = dup ? getComputedStyle(dup).display : 'absent';
    const titles = Array.from(container.querySelectorAll('li'))
      .filter(shown)
      .map((li) => li.textContent?.match(/Story \d+/)?.[0]);

    expect({ dupShown, cards: titles.length }).toEqual({ dupShown: dup ? 'none' : 'absent', cards: 30 });
  });
});
