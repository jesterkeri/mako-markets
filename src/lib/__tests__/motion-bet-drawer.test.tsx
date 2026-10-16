// Motion pass 3 (Joshua 2026-10-16): the pool page's mobile bet drawer closes when a downward drag is far enough
// (over 60 px) or fast enough (over 0.11 px/ms over the gesture, and at least 10 px so a tap that slips does not count);
// after a drag that does not close it, the panel snaps back with transform 240 ms on the drawer curve; the bet form
// enters with @starting-style (opacity 0, translateY(8px), 200 ms ease-out). Reduced motion: no translate, fade only.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';

import { MarketType, Outcome, type MarketWithId } from '@/lib/contract';
import { shouldCloseDrawer, SWIPE_CLOSE_PX, SWIPE_CLOSE_VELOCITY, SWIPE_FLICK_MIN_PX } from '@/lib/drawer-swipe';
import { durations, inReducedMotion, inStartingStyle, rulesFor, SHELL } from './helpers/motion-css';

vi.mock('@/components/MarketChart', () => ({ MarketChart: () => null }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('notFound'); } }));
vi.mock('@/components/comments/PoolComments', () => ({ PoolCommentsDesktop: () => null, PoolCommentsMobile: () => null }));
vi.mock('@/lib/use-mako-labels', () => ({ useMakoLabels: () => ({ data: undefined }) }));
vi.mock('@/lib/use-address-names', () => ({ useAddressNames: () => new Map() }));

const USDC = 1_000_000n;
const NOW = Math.floor(Date.now() / 1000);
const OPEN: MarketWithId = {
  id: 7n,
  creator: '0x00000000000000000000000000000000000000c1',
  mType: MarketType.CRYPTO,
  oracleRef: '0x4254433a67743a31000000000000000000000000000000000000000000000000', // BTC:gt:1
  question: 'Will BTC close above $80,000 in 1 day?',
  createdAt: BigInt(NOW - 3600),
  closeTime: BigInt(NOW + 2 * 86400),
  bettingCloseTime: BigInt(NOW + 86400),
  totalYes: 30n * USDC,
  totalNo: 10n * USDC,
  yesBettorCount: 2,
  noBettorCount: 1,
  outcome: Outcome.UNRESOLVED,
  resolved: false,
  creatorFeeClaimed: false,
  protocolFeeBpsSnapshot: 100,
  creatorFeeBpsSnapshot: 200,
};

vi.mock('wagmi', () => ({
  useReadContract: () => ({ data: undefined, refetch: vi.fn() }),
  useReadContracts: () => ({ data: undefined, refetch: vi.fn() }),
  useAccount: () => ({ address: undefined }),
  usePublicClient: () => ({ readContract: vi.fn() }),
  useWriteContract: () => ({ writeContractAsync: vi.fn() }),
}));
vi.mock('@/lib/hooks', () => ({
  useMarket: () => ({ market: OPEN, isLoading: false, isError: false, refetch: vi.fn() }),
  useMarkets: () => ({ markets: [OPEN] }),
  useUsdcBalance: () => ({ data: undefined, refetch: vi.fn() }),
  useEnsureMonadChain: () => vi.fn(),
}));
vi.mock('@/lib/use-user', () => ({
  useUser: () => ({ user: null }),
  accountAddress: () => null,
}));

const { PoolClient } = await import('@/app/pools/[id]/PoolClient');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('shouldCloseDrawer (the decision, pure)', () => {
  it('the thresholds are the approved ones', () => {
    expect(SWIPE_CLOSE_PX).toBe(60);
    expect(SWIPE_CLOSE_VELOCITY).toBe(0.11);
    expect(SWIPE_FLICK_MIN_PX).toBe(10);
  });

  it('a fast short flick closes it', () => {
    expect(shouldCloseDrawer(30, 120)).toBe(true); // 0.25 px/ms
    expect(shouldCloseDrawer(12, 60)).toBe(true); // 0.2 px/ms
  });

  it('a long slow drag closes it', () => {
    expect(shouldCloseDrawer(61, 5000)).toBe(true);
    expect(shouldCloseDrawer(200, 3000)).toBe(true);
  });

  it('a slow short drag does not', () => {
    expect(shouldCloseDrawer(30, 1000)).toBe(false); // 0.03 px/ms
    expect(shouldCloseDrawer(55, 600)).toBe(false); // 0.092 px/ms
    expect(shouldCloseDrawer(60, 5000)).toBe(false); // the distance rule is "more than 60"
  });

  it('the speed rule is strict, and in the closing direction only', () => {
    expect(shouldCloseDrawer(22, 200)).toBe(false); // exactly 0.11
    expect(shouldCloseDrawer(23, 200)).toBe(true);
    expect(shouldCloseDrawer(-80, 50)).toBe(false); // up, however fast
    expect(shouldCloseDrawer(0, 10)).toBe(false);
  });

  it('a tap that slips a few pixels is not a flick, however quick', () => {
    expect(shouldCloseDrawer(5, 10)).toBe(false);
    expect(shouldCloseDrawer(9, 1)).toBe(false);
  });

  it('a zero or negative duration does not divide by zero', () => {
    expect(shouldCloseDrawer(15, 0)).toBe(true);
    expect(shouldCloseDrawer(15, -5)).toBe(true);
    expect(shouldCloseDrawer(Number.NaN, 100)).toBe(false);
  });
});

describe('the drawer on the pool page (mobile)', () => {
  function page() {
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: false } as MediaQueryList);
    const view = render(<PoolClient id={7n} initialSide={null} />);
    const drawer = view.container.querySelector<HTMLElement>('.mk-betdrawer')!;
    expect(drawer, 'the bet drawer').not.toBeNull();
    return drawer;
  }
  const form = (drawer: HTMLElement) => drawer.querySelector<HTMLElement>('.mk-betform');
  // The panel starts open on an open pool; this checks that, or opens it again after a close.
  async function openIt(drawer: HTMLElement) {
    const show = screen.queryByRole('button', { name: 'Show the bet panel' });
    if (show)
      await act(async () => {
        fireEvent.click(show);
      });
    expect(form(drawer)).not.toBeNull();
  }
  /// A drag from y=500 down by `dy` px taking `ms` (the touch events' timeStamps come from performance.now()).
  async function drag(drawer: HTMLElement, dy: number, ms: number) {
    const clock = vi.spyOn(performance, 'now');
    clock.mockReturnValue(10_000);
    await act(async () => {
      fireEvent.touchStart(drawer, { touches: [{ clientY: 500 }] });
    });
    clock.mockReturnValue(10_000 + ms / 2);
    await act(async () => {
      fireEvent.touchMove(drawer, { touches: [{ clientY: 500 + dy }] });
    });
    // While the finger drags, the panel follows it with no transition.
    expect(drawer.hasAttribute('data-dragging')).toBe(dy > 0);
    clock.mockReturnValue(10_000 + ms);
    await act(async () => {
      fireEvent.touchEnd(drawer, { changedTouches: [{ clientY: 500 + dy }] });
    });
    clock.mockRestore();
    expect(drawer.hasAttribute('data-dragging')).toBe(false);
  }

  it('the form block carries the entrance, inside the same column, and mounts again on every open', async () => {
    const drawer = page();
    await openIt(drawer);
    const first = form(drawer)!;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Hide the bet panel' }));
    });
    expect(form(drawer)).toBeNull();
    await openIt(drawer);
    const f = form(drawer)!;
    expect(f).not.toBe(first);
    expect(f.style.display).toBe('flex');
    expect(f.style.flexDirection).toBe('column');
    expect(f.style.gap).toBe('10px');
    expect(drawer.style.transition).toBe('');
  });

  it('a fast short flick closes it', async () => {
    const drawer = page();
    await openIt(drawer);
    await drag(drawer, 30, 120);
    expect(form(drawer)).toBeNull();
  });

  it('a long slow drag closes it', async () => {
    const drawer = page();
    await openIt(drawer);
    await drag(drawer, 120, 3000);
    expect(form(drawer)).toBeNull();
  });

  it('a slow short drag snaps back open', async () => {
    const drawer = page();
    await openIt(drawer);
    await drag(drawer, 30, 1000);
    expect(form(drawer)).not.toBeNull();
    expect(drawer.style.transform).toBe('');
  });
});

describe('the drawer: the shipped CSS', () => {
  it('snap back is transform 240 ms on the drawer curve, off while dragging', () => {
    const [base] = rulesFor(SHELL, '.mk-betdrawer', 'top');
    expect(base.decls.get('transition')).toBe('transform 240ms cubic-bezier(0.32, 0.72, 0, 1)');
    const [dragging] = rulesFor(SHELL, '.mk-betdrawer[data-dragging]', 'top');
    expect(dragging.decls.get('transition')).toBe('none');
  });

  it('the form enters from opacity 0 + translateY(8px) over 200 ms ease-out (@starting-style)', () => {
    const [base] = rulesFor(SHELL, '.mk-betform', 'top');
    const t = base.decls.get('transition')!;
    expect(t).toMatch(/opacity 200ms cubic-bezier\(0\.23, 1, 0\.32, 1\)/);
    expect(t).toMatch(/transform 200ms cubic-bezier\(0\.23, 1, 0\.32, 1\)/);
    const start = rulesFor(SHELL, '.mk-betform', (c) => inStartingStyle(c) && !inReducedMotion(c));
    expect(start).toHaveLength(1);
    expect(start[0].decls.get('opacity')).toBe('0');
    expect(start[0].decls.get('transform')).toBe('translateY(8px)');
  });

  it('reduced motion: no snap-back movement, the form fades in without rising', () => {
    const drawer = rulesFor(SHELL, '.mk-betdrawer', inReducedMotion);
    expect(drawer[0].decls.get('transition')).toBe('none');
    const formT = rulesFor(SHELL, '.mk-betform', (c) => inReducedMotion(c) && !inStartingStyle(c));
    expect(formT[0].decls.get('transition')).toMatch(/^opacity 200ms /);
    expect(formT[0].decls.get('transition')).not.toMatch(/transform/);
    const start = rulesFor(SHELL, '.mk-betform', (c) => inReducedMotion(c) && inStartingStyle(c));
    expect(start[0].decls.get('opacity')).toBe('0');
    expect(start[0].decls.get('transform')).toBe('none');
    expect(durations(formT[0].decls.get('transition')!)).toEqual([200]);
  });
});
