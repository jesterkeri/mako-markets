// How to play (20a): the tour opens from `?tour=<n>`, each step opens its own page, Back/Next/Skip move through the
// seven steps, closing removes only `tour` from the URL, the last step hands over to Circle's faucet, and every line
// of copy says only what is true today.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';

const nav = vi.hoisted(() => ({
  path: '/',
  search: '',
  push: vi.fn(),
  replace: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => nav.path,
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
}));

import { HowToPlay } from '@/components/shell/HowToPlay';
import { SPONSOR_CAP_PER_USER_PER_DAY } from '@/lib/aa-constants';
import { CIRCLE_FAUCET_URL } from '@/lib/list-states';
import { tabBarHidden, TOUR_STEPS, tourHref, tourLabelDesktop, tourLabelMobile, tourStepFromParam, useTourStep } from '@/lib/tour';

function StepProbe() {
  return <span data-testid="probe">{String(useTourStep())}</span>;
}

function open(path: string, search: string) {
  nav.path = path;
  nav.search = search;
  return render(
    <>
      <HowToPlay />
      <StepProbe />
    </>,
  );
}

beforeEach(() => {
  nav.push.mockClear();
  nav.replace.mockClear();
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the ?tour= parameter', () => {
  it('names steps 1 to 7 and nothing else', () => {
    expect(tourStepFromParam('1')).toBe(0);
    expect(tourStepFromParam('7')).toBe(6);
    for (const bad of [null, '', '0', '8', '9', '01', '1x', ' 1', '-1', '1.0']) expect(tourStepFromParam(bad)).toBeNull();
  });

  it('shows nothing without a valid step', () => {
    for (const search of ['', 'tour=0', 'tour=8', 'tour=abc']) {
      open('/', search);
      expect(screen.queryAllByRole('dialog', { name: 'How to play' })).toHaveLength(0);
      expect(screen.getByTestId('probe').textContent).toBe('null');
      cleanup();
    }
  });

  it('each step opens the page it explains', () => {
    expect(TOUR_STEPS.map((_, i) => tourHref(i))).toEqual([
      '/?tour=1',
      '/rounds?tour=2',
      '/pools?tour=3',
      '/pools/new?tour=4',
      '/leaderboard?tour=5',
      '/me?tour=6',
      '/me?tour=7',
    ]);
  });
});

describe('moving through the tour', () => {
  it('step 1 has no Back; Next opens Rounds; the open step is published for the chrome', () => {
    open('/', 'tour=1');
    expect(screen.getAllByText('Everything at a glance').length).toBeGreaterThan(0);
    expect(screen.getAllByText('STEP 1 OF 7 · HOME').length).toBeGreaterThan(0);
    expect(screen.queryAllByRole('button', { name: 'Back' })).toHaveLength(0);
    expect(screen.getByTestId('probe').textContent).toBe('0');
    fireEvent.click(screen.getAllByRole('button', { name: 'Next' })[0]);
    expect(nav.push).toHaveBeenCalledWith('/rounds?tour=2');
  });

  it('Back goes to the previous step and Skip jumps to the last one', () => {
    open('/rounds', 'tour=2');
    expect(screen.getAllByText('STEP 2 OF 7 · ROUNDS TAB').length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole('button', { name: 'Back' })[0]);
    expect(nav.push).toHaveBeenLastCalledWith('/?tour=1');
    fireEvent.click(screen.getAllByRole('button', { name: 'SKIP' })[0]);
    expect(nav.push).toHaveBeenLastCalledWith('/me?tour=7');
  });

  it('the last step hands over to Circle’s faucet in a new tab and ends the tour', () => {
    open('/me', 'tour=7');
    const links = screen.getAllByRole('link', { name: 'Get test USDC ↗' });
    expect(links.length).toBeGreaterThan(0);
    for (const a of links) {
      expect(a.getAttribute('href')).toBe(CIRCLE_FAUCET_URL);
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    }
    fireEvent.click(links[0]);
    expect(nav.replace).toHaveBeenCalledWith('/me', { scroll: false });
  });

  it('Skip on the last step, and Escape anywhere, close it and keep the page’s other parameters', () => {
    open('/me', 'tour=7');
    fireEvent.click(screen.getAllByRole('button', { name: 'SKIP' })[0]);
    expect(nav.replace).toHaveBeenLastCalledWith('/me', { scroll: false });
    cleanup();
    open('/pools', 'side=yes&tour=3');
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(nav.replace).toHaveBeenLastCalledWith('/pools?side=yes', { scroll: false });
  });

  it('on a phone the card carries the short copy and the same controls', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: false } as MediaQueryList);
    open('/rounds', 'tour=2');
    expect(screen.getAllByText('Step 2 of 7 · Rounds').length).toBeGreaterThan(0);
    expect(screen.getAllByText(TOUR_STEPS[1].bodyMobile).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole('button', { name: 'Skip' })[0]);
    expect(nav.push).toHaveBeenLastCalledWith('/me?tour=7');
  });

  it('the labels name the step and the tab it lives in', () => {
    expect(tourLabelDesktop(0)).toBe('STEP 1 OF 7 · HOME');
    expect(tourLabelDesktop(1)).toBe('STEP 2 OF 7 · ROUNDS TAB');
    expect(tourLabelDesktop(3)).toBe('STEP 4 OF 7 · CREATE · IN POOLS');
    expect(tourLabelDesktop(6)).toBe('STEP 7 OF 7 · TEST USDC · IN ME');
    expect(tourLabelMobile(6)).toBe('Step 7 of 7 · Test USDC');
  });

  it('the mobile tab bar steps aside only on Home and the create form', () => {
    expect([0, 1, 2, 3, 4, 5, 6, null].map((i) => tabBarHidden(i))).toEqual([true, false, false, true, false, false, false, false]);
  });
});

describe('the copy is true today', () => {
  const all = TOUR_STEPS.flatMap((s) => [s.title, s.body, s.bodyMobile, ...(s.facts ?? []).flat()]);

  it('rounds are not live, so their step and Home say coming soon', () => {
    const rounds = TOUR_STEPS[1];
    expect(rounds.body).toMatch(/^Coming soon: rounds are not live yet\./);
    expect(rounds.bodyMobile).toMatch(/^Coming soon/);
    expect(rounds.facts).toContainEqual(['STATUS', 'COMING SOON']);
    expect(TOUR_STEPS[0].body).toMatch(/rounds coming soon/);
  });

  it('pools: one-sided pools refund; no promise of a refund for every unsettled pool', () => {
    expect(TOUR_STEPS[2].body).toContain('if only one side has bets, everyone is refunded');
    expect(all.join(' ')).not.toMatch(/within 24H|REFUND IN 24H/i);
  });

  it('create: the seed and the creator fee follow the Pools contract', () => {
    expect(TOUR_STEPS[3].body).toContain('1 USDC or more');
    expect(TOUR_STEPS[3].body).toContain('2% of the whole pool');
    expect(TOUR_STEPS[3].body).toContain('about 4%');
    expect(all.join(' ')).not.toMatch(/2% of the smaller side|FREE · GAS COVERED/);
  });

  it('test USDC comes from Circle’s faucet, and the gas line matches the sponsor cap', () => {
    expect(TOUR_STEPS[6].body).toContain('Circle’s faucet');
    expect(TOUR_STEPS[6].body).toContain(`up to ${SPONSOR_CAP_PER_USER_PER_DAY} transactions a day`);
    expect(all.join(' ')).not.toMatch(/Get 10|10 test USDC|every 24 hours/);
  });

  it('the leaderboard has rolling periods and no badges yet', () => {
    expect(TOUR_STEPS[4].body).toContain('7 days, 30 days or all time');
    expect(TOUR_STEPS[4].body).toContain('badges are coming soon');
    expect(all.join(' ')).not.toMatch(/reset every week/i);
  });

  it('no em-dashes, and the brand speaks as Mako Market, never we/our/us/team', () => {
    for (const line of all) {
      expect(line).not.toMatch(/—/);
      expect(line).not.toMatch(/\b(we|our|us|team)\b/i);
    }
  });
});

// Reduced motion is fade only (DESIGN_RULES; Codex S7 r1): a pointer target below the fold is scrolled to at once,
// and the card and its arrow do not slide. Without the preference both keep their motion.
describe('reduced motion', () => {
  function media({ desktop, reduced }: { desktop: boolean; reduced: boolean }) {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (q: string) => ({ matches: q.includes('reduce') ? reduced : desktop, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList,
    );
  }
  // jsdom lays nothing out: report every element as rendered, the anchors far below the fold.
  function layout() {
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ top: 2000, bottom: 2040, left: 300, right: 420, width: 120, height: 40, x: 300, y: 2000, toJSON() {} } as DOMRect);
  }
  function page(path: string, search: string, extra: React.ReactNode) {
    nav.path = path;
    nav.search = search;
    return render(
      <>
        {extra}
        <HowToPlay />
      </>,
    );
  }
  const slidingIn = (root: HTMLElement) => [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))].filter((el) => el.style.transition.includes('left'));

  for (const reduced of [true, false]) {
    it(`${reduced ? 'with' : 'without'} it, a below-fold pointer target scrolls ${reduced ? 'instantly' : 'smoothly'}`, () => {
      media({ desktop: true, reduced });
      layout();
      const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
      page(
        '/pools',
        'tour=3',
        <div className="mk-desk">
          <div data-tour-anchor="pools-topics">
            <button data-tour-point="pools-topics">CRYPTO</button>
          </div>
        </div>,
      );
      expect(scroll).toHaveBeenCalledWith(expect.objectContaining({ behavior: reduced ? 'instant' : 'smooth' }));
    });

    it(`${reduced ? 'with' : 'without'} it, the desktop tab card and its arrow ${reduced ? 'do not slide' : 'slide'}`, () => {
      media({ desktop: true, reduced });
      layout();
      page(
        '/rounds',
        'tour=2',
        <div className="mk-desk">
          <nav aria-label="Main">
            {/* A stand-in for the shell's nav link, which the tour finds by its href. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/rounds">Rounds</a>
          </nav>
        </div>,
      );
      const card = screen.getAllByRole('dialog', { name: 'How to play' })[0];
      expect(slidingIn(card)).toHaveLength(reduced ? 0 : 2);
    });

    it(`${reduced ? 'with' : 'without'} it, the mobile card's arrow ${reduced ? 'does not slide' : 'slides'}`, () => {
      media({ desktop: false, reduced });
      layout();
      page(
        '/rounds',
        'tour=2',
        <div className="mk-mob">
          <nav aria-label="Main">
            {/* A stand-in for the shell's nav link, which the tour finds by its href. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/rounds">Rounds</a>
          </nav>
        </div>,
      );
      const card = screen.getAllByRole('dialog', { name: 'How to play' })[0];
      expect(slidingIn(card)).toHaveLength(reduced ? 0 : 1);
    });
  }
});
