// Motion pass 5 (Joshua 2026-10-16): the How to play card is keyed on the step, so each step mounts a fresh card and
// its existing mk-pop entrance plays again, grown from the arrow (transform-origin at the caret); it never slides from
// the previous step's anchor. Two things make the card a new element per step: the key, and the rule that a card
// renders only at a place measured for its own step (so it is absent for the moment between steps). Either alone
// passes these tests; both are kept, since the key also covers a step whose card needs no measured place.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import * as React from 'react';

const nav = vi.hoisted(() => ({ path: '/', search: '', push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.path,
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
}));

import { HowToPlay } from '@/components/shell/HowToPlay';

function media(desktop: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (q: string) => ({ matches: q.includes('reduce') ? false : desktop, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList,
  );
}
// Nothing is laid out: every element is "rendered", at one rect.
function layout() {
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ top: 20, bottom: 60, left: 300, right: 420, width: 120, height: 40, x: 300, y: 20, toJSON() {} } as DOMRect);
}

/* eslint-disable @next/next/no-html-link-for-pages -- stand-ins for the shell's nav links, found by href */
function Page({ wrap }: { wrap: 'mk-desk' | 'mk-mob' }) {
  return (
    <>
      <div className={wrap}>
        <nav aria-label="Main">
          <a href="/rounds">Rounds</a>
          <a href="/leaderboard">Leaderboard</a>
        </nav>
      </div>
      <HowToPlay />
    </>
  );
}
/* eslint-enable @next/next/no-html-link-for-pages */

const card = () => screen.getAllByRole('dialog', { name: 'How to play' })[0];
/// The card's arrow: the aria-hidden triangle at its top or bottom edge.
const caretOf = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>(':scope > span[aria-hidden="true"]')].find((s) => s.style.width === '0px')!;

beforeEach(() => {
  nav.push.mockClear();
  nav.replace.mockClear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the tour card per step', () => {
  it('desktop: each step mounts a new card with the pop entrance, grown from its arrow', async () => {
    media(true);
    layout();
    nav.path = '/rounds';
    nav.search = 'tour=2';
    const view = render(<Page wrap="mk-desk" />);
    const first = card();
    expect(first.classList.contains('mk-pop')).toBe(true);
    const caret = caretOf(first);
    expect(caret, 'the tab card has an arrow').toBeDefined();
    expect(first.style.transformOrigin).toBe(`${caret.style.left} top`);
    expect(first.style.transition).toBe('');
    expect(caret.style.transition).toBe('');

    nav.path = '/leaderboard';
    nav.search = 'tour=5';
    await act(async () => {
      view.rerender(<Page wrap="mk-desk" />);
    });
    const second = card();
    expect(second).not.toBe(first);
    expect(first.isConnected).toBe(false);
    expect(second.classList.contains('mk-pop')).toBe(true);
    expect(second.textContent).toContain('STEP 5 OF 7');
  });

  it('desktop: from the Mako card to a tab card is a new card too', async () => {
    media(true);
    layout();
    nav.path = '/';
    nav.search = 'tour=1';
    const view = render(<Page wrap="mk-desk" />);
    const first = card();
    // The Mako card's arrow is on its right edge, 52px up from the bottom.
    expect(first.style.transformOrigin).toBe('100% calc(100% - 52px)');
    nav.path = '/rounds';
    nav.search = 'tour=2';
    await act(async () => {
      view.rerender(<Page wrap="mk-desk" />);
    });
    expect(card()).not.toBe(first);
  });

  it('mobile: each step mounts a new card, grown from the arrow on its bottom edge', async () => {
    media(false);
    layout();
    nav.path = '/rounds';
    nav.search = 'tour=2';
    const view = render(<Page wrap="mk-mob" />);
    const first = card();
    expect(first.classList.contains('mk-pop')).toBe(true);
    const caret = caretOf(first);
    expect(caret.style.bottom).toBe('-9px');
    expect(first.style.transformOrigin).toBe(`${caret.style.left} bottom`);

    nav.path = '/leaderboard';
    nav.search = 'tour=5';
    await act(async () => {
      view.rerender(<Page wrap="mk-mob" />);
    });
    expect(card()).not.toBe(first);
    expect(card().classList.contains('mk-pop')).toBe(true);
  });

  it('the same step re-rendering (the 250 ms re-measure) keeps the same card', async () => {
    media(true);
    layout();
    nav.path = '/rounds';
    nav.search = 'tour=2';
    const view = render(<Page wrap="mk-desk" />);
    const first = card();
    await act(async () => {
      view.rerender(<Page wrap="mk-desk" />);
    });
    expect(card()).toBe(first);
  });
});
