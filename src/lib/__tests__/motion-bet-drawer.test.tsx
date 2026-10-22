// Motion pass 3 (Joshua 2026-10-16): the pool page's mobile bet drawer closes when a downward drag is far enough
// (over 60 px) or fast enough (over 0.11 px/ms over the last 100 ms before release, and at least 10 px so a tap that
// slips does not count);
// after a drag that does not close it, the panel snaps back with transform 240 ms on the drawer curve; the bet form
// enters with @starting-style (opacity 0, translateY(8px), 200 ms ease-out). Reduced motion: no translate, fade only.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';

import { MarketType, Outcome, type MarketWithId } from '@/lib/contract';
import { addTouchSample, shouldCloseDrawer, SWIPE_CLOSE_PX, SWIPE_CLOSE_VELOCITY, SWIPE_FLICK_MIN_PX, SWIPE_VELOCITY_WINDOW_MS, type TouchSample } from '@/lib/drawer-swipe';
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

describe('shouldCloseDrawer (the decision, pure, over the touch samples)', () => {
  /// A finger moving down `dy` px at a steady speed over `ms`, sampled every 16 ms (a touchmove a frame), then lifted.
  const steady = (dy: number, ms: number): TouchSample[] => {
    const out: TouchSample[] = [];
    for (let t = 0; t < ms; t += 16) out.push({ y: 500 + (dy * t) / ms, t });
    out.push({ y: 500 + dy, t: ms });
    return out;
  };
  /// Fed through addTouchSample as the drawer does, so the pruning is exercised too.
  const fed = (samples: TouchSample[]) => samples.reduce<TouchSample[]>((acc, s) => addTouchSample(acc, s), []);
  const close = (samples: TouchSample[]) => {
    const direct = shouldCloseDrawer(samples);
    expect(shouldCloseDrawer(fed(samples)), 'the pruned samples decide the same').toBe(direct);
    return direct;
  };

  it('the thresholds are the approved ones', () => {
    expect(SWIPE_CLOSE_PX).toBe(60);
    expect(SWIPE_CLOSE_VELOCITY).toBe(0.11);
    expect(SWIPE_FLICK_MIN_PX).toBe(10);
    expect(SWIPE_VELOCITY_WINDOW_MS).toBe(100);
  });

  it('a fast short flick closes it', () => {
    expect(close(steady(30, 120))).toBe(true); // 0.25 px/ms
    expect(close(steady(12, 60))).toBe(true); // 0.2 px/ms
  });

  it('a long slow drag closes it', () => {
    expect(close(steady(61, 5000))).toBe(true);
    expect(close(steady(200, 3000))).toBe(true);
  });

  it('a slow short drag does not', () => {
    expect(close(steady(30, 1000))).toBe(false); // 0.03 px/ms
    expect(close(steady(55, 600))).toBe(false); // 0.092 px/ms
    expect(close(steady(60, 5000))).toBe(false); // the distance rule is "more than 60"
  });

  it('adversary on c0bcd32: a 400 ms rest and then a 40 px flick in 50 ms closes it (the speed is at release)', () => {
    const flick: TouchSample[] = [
      { y: 500, t: 0 },
      { y: 500, t: 400 }, // a still finger may or may not send a move; both are covered below
      { y: 516, t: 416 },
      { y: 532, t: 432 },
      { y: 540, t: 450 },
    ];
    expect(close(flick)).toBe(true);
    expect(close(flick.filter((s) => s.t !== 400))).toBe(true);
    // Averaged over the whole touch it was 40 / 450 = 0.089 px/ms, which is why it used to stay open.
    expect(40 / 450).toBeLessThan(SWIPE_CLOSE_VELOCITY);
  });

  it('a pull that stops before the finger lifts is not a flick', () => {
    // 50 px in 200 ms (0.25 px/ms), then held still for 300 ms and lifted.
    const held = [...steady(50, 200), { y: 550, t: 500 }];
    expect(close(held)).toBe(false);
    // The same pull lifted while moving closes.
    expect(close(steady(50, 200))).toBe(true);
  });

  it('the speed rule is strict, measured over the last 100 ms, and in the closing direction only', () => {
    expect(close([{ y: 0, t: 0 }, { y: 11, t: 100 }])).toBe(false); // exactly 0.11
    expect(close([{ y: 0, t: 0 }, { y: 12, t: 100 }])).toBe(true);
    // A rest first: only the last 100 ms count.
    expect(close([{ y: 0, t: 0 }, { y: 0, t: 400 }, { y: 11, t: 500 }])).toBe(false);
    expect(close([{ y: 0, t: 0 }, { y: 0, t: 400 }, { y: 12, t: 500 }])).toBe(true);
    // The finger stood where the last sample put it: the window starts at 400 at y 0, not at the 0 ms sample's time.
    expect(close([{ y: 0, t: 0 }, { y: 15, t: 500 }])).toBe(true); // 15 px in the window's 100 ms
    expect(close([{ y: 0, t: 0 }, { y: -80, t: 50 }])).toBe(false); // up, however fast
    expect(close([{ y: 0, t: 0 }, { y: 0, t: 10 }])).toBe(false);
    // Down overall, but moving back up as it was released.
    expect(close([...steady(40, 300), { y: 535, t: 316 }, { y: 530, t: 332 }, { y: 525, t: 348 }, { y: 520, t: 364 }])).toBe(false);
  });

  it('a tap that slips a few pixels is not a flick, however quick', () => {
    expect(close([{ y: 0, t: 0 }, { y: 5, t: 10 }])).toBe(false);
    expect(close([{ y: 0, t: 0 }, { y: 9, t: 1 }])).toBe(false);
    // The 10 px minimum is the whole touch's travel: a 9 px slip after a rest is still a slip.
    expect(close([{ y: 0, t: 0 }, { y: 0, t: 300 }, { y: 9, t: 310 }])).toBe(false);
  });

  it('a zero or negative duration does not divide by zero; junk does not close it', () => {
    expect(close([{ y: 0, t: 0 }, { y: 15, t: 0 }])).toBe(true);
    expect(close([{ y: 0, t: 0 }, { y: 15, t: -5 }])).toBe(true);
    expect(close([{ y: 0, t: 0 }, { y: Number.NaN, t: 100 }])).toBe(false);
    expect(close([{ y: 0, t: 0 }, { y: 30, t: Number.NaN }])).toBe(false);
    expect(close([{ y: 0, t: 0 }])).toBe(false);
    expect(shouldCloseDrawer([])).toBe(false);
  });

  it('addTouchSample keeps the first sample and what the window can still need, and stays bounded on a long hold', () => {
    let acc: TouchSample[] = [];
    for (let t = 0; t <= 10_000; t += 8) acc = addTouchSample(acc, { y: 500 + t / 100, t });
    expect(acc[0]).toEqual({ y: 500, t: 0 });
    expect(acc.length).toBeLessThan(20);
    // The latest sample at or before (now - window) is still there.
    expect(acc.some((s) => s.t <= 10_000 - SWIPE_VELOCITY_WINDOW_MS)).toBe(true);
    expect(acc.filter((s, i) => i > 0 && s.t <= 10_000 - SWIPE_VELOCITY_WINDOW_MS)).toHaveLength(1);
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

  it('a 400 ms rest, then a 40 px flick in 50 ms, closes it (release speed; adversary on c0bcd32)', async () => {
    const drawer = page();
    await openIt(drawer);
    const clock = vi.spyOn(performance, 'now');
    const at = async (t: number, fire: () => void) => {
      clock.mockReturnValue(10_000 + t);
      await act(async () => fire());
    };
    await at(0, () => fireEvent.touchStart(drawer, { touches: [{ clientY: 500 }] }));
    await at(416, () => fireEvent.touchMove(drawer, { touches: [{ clientY: 516 }] }));
    await at(432, () => fireEvent.touchMove(drawer, { touches: [{ clientY: 532 }] }));
    await at(450, () => fireEvent.touchEnd(drawer, { changedTouches: [{ clientY: 540 }] }));
    clock.mockRestore();
    expect(form(drawer)).toBeNull();
  });

  it('a pull that stops before the finger lifts snaps back open', async () => {
    const drawer = page();
    await openIt(drawer);
    const clock = vi.spyOn(performance, 'now');
    const at = async (t: number, fire: () => void) => {
      clock.mockReturnValue(10_000 + t);
      await act(async () => fire());
    };
    await at(0, () => fireEvent.touchStart(drawer, { touches: [{ clientY: 500 }] }));
    for (let t = 16; t <= 192; t += 16) await at(t, () => fireEvent.touchMove(drawer, { touches: [{ clientY: 500 + t / 4 }] }));
    await at(500, () => fireEvent.touchEnd(drawer, { changedTouches: [{ clientY: 548 }] }));
    clock.mockRestore();
    expect(form(drawer)).not.toBeNull();
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
