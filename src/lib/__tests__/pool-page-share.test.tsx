// The pool page (9a) opens Share (15a) from its header (every state) and its receipt's share control, on desktop and
// mobile, instead of copying the page's address; Escape closes it and focus goes back to the control that opened it.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import * as React from 'react';

import { MarketType, Outcome, type MarketWithId } from '@/lib/contract';

// The price chart fetches its own data (tested in chart-components.test.tsx); this test is about the page around it.
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

// Settled YES by default (the receipt and its share control show); `state.market` switches to an open pool.
const SETTLED: MarketWithId = {
  id: 7n,
  creator: '0x00000000000000000000000000000000000000c1',
  mType: MarketType.CRYPTO,
  oracleRef: '0x4254433a67743a31000000000000000000000000000000000000000000000000', // BTC:gt:1, a reference the resolver reads
  question: 'Will BTC close above $80,000 in 1 day?',
  createdAt: BigInt(NOW - 10 * 3600),
  closeTime: BigInt(NOW - 3600),
  bettingCloseTime: BigInt(NOW - 2 * 3600),
  totalYes: 30n * USDC,
  totalNo: 10n * USDC,
  yesBettorCount: 2,
  noBettorCount: 1,
  outcome: Outcome.YES,
  resolved: true,
  creatorFeeClaimed: false,
  protocolFeeBpsSnapshot: 100,
  creatorFeeBpsSnapshot: 200,
};
const OPEN: MarketWithId = { ...SETTLED, closeTime: BigInt(NOW + 2 * 86400), bettingCloseTime: BigInt(NOW + 86400), outcome: Outcome.UNRESOLVED, resolved: false };
const state = vi.hoisted(() => ({ market: null as unknown }));

vi.mock('wagmi', () => ({
  useReadContract: () => ({ data: undefined, refetch: vi.fn() }),
  useReadContracts: () => ({ data: undefined, refetch: vi.fn() }),
  useAccount: () => ({ address: undefined }),
  usePublicClient: () => ({ readContract: vi.fn() }),
  useWriteContract: () => ({ writeContractAsync: vi.fn() }),
}));
vi.mock('@/lib/hooks', () => ({
  useMarket: () => ({ market: (state.market ?? SETTLED) as MarketWithId, isLoading: false, isError: false, refetch: vi.fn() }),
  useMarkets: () => ({ markets: [(state.market ?? SETTLED) as MarketWithId] }),
  useUsdcBalance: () => ({ data: undefined, refetch: vi.fn() }),
  useEnsureMonadChain: () => vi.fn(),
}));
vi.mock('@/lib/use-user', () => ({
  useUser: () => ({ user: null }),
  accountAddress: () => null,
}));

const { PoolClient } = await import('@/app/pools/[id]/PoolClient');

afterEach(() => {
  state.market = null;
  cleanup();
  vi.restoreAllMocks();
});

function renderPage(desktop: boolean) {
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: desktop } as MediaQueryList);
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  render(<PoolClient id={7n} initialSide={null} />);
  return { writeText };
}

describe('pool page share control', () => {
  it('desktop: SHARE opens the share sheet instead of copying the address, and Escape returns focus to it', async () => {
    const { writeText } = renderPage(true);
    expect(screen.queryByRole('dialog', { name: 'Share' })).toBeNull();

    // The receipt's control (the header has its own, tested below).
    const control = screen.getAllByRole('button', { name: 'SHARE ↗' })[1];
    control.focus();
    await act(async () => {
      fireEvent.click(control);
    });
    expect(screen.getAllByRole('dialog', { name: 'Share' }).length).toBeGreaterThan(0);
    expect(writeText).not.toHaveBeenCalled();
    // The card is the pool's own: its state, not a call to bet.
    expect(screen.getAllByText('YES WON').length).toBeGreaterThan(0);
    expect(screen.queryByText('Scan to join')).toBeNull();

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(screen.queryByRole('dialog', { name: 'Share' })).toBeNull();
    expect(document.activeElement).toBe(control);
  });

  it('mobile: the receipt card has a Share control that opens the same sheet', async () => {
    renderPage(false);
    const control = screen.getByRole('button', { name: 'Share' });
    await act(async () => {
      fireEvent.click(control);
    });
    expect(screen.getAllByRole('dialog', { name: 'Share' }).length).toBeGreaterThan(0);
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]);
    });
    expect(screen.queryByRole('dialog', { name: 'Share' })).toBeNull();
  });

  it('an open pool is shared from the header, desktop and mobile, and its card asks people to join', async () => {
    state.market = OPEN;
    renderPage(true);
    expect(screen.queryByText('Result receipt')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'SHARE ↗' }));
    });
    expect(screen.getAllByText('Scan to join').length).toBeGreaterThan(0);
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Share pool' }));
    });
    expect(screen.getAllByRole('dialog', { name: 'Share' }).length).toBeGreaterThan(0);
  });

  // Joshua, 2026-10-08: on a phone the bet panel starts open and can be shrunk, so reading or commenting is not
  // covered by it.
  it('mobile: the bet panel collapses to a slim YES/NO bar and opens again from it', async () => {
    state.market = OPEN;
    renderPage(false);
    const signIns = () => screen.queryAllByRole('link', { name: 'Sign in to bet' }).length;
    const open = signIns();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Hide the bet panel' }));
    });
    expect(signIns(), 'the panel form is gone').toBe(open - 1);
    expect(screen.getByRole('button', { name: 'Show the bet panel' }).getAttribute('aria-expanded')).toBe('false');
    const panel = screen.getByRole('button', { name: 'Show the bet panel' }).parentElement as HTMLElement;
    expect(within(panel).getByRole('button', { name: 'Bet' })).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(panel).getByRole('button', { name: /^NO/ }));
    });
    expect(signIns(), 'the panel form is back').toBe(open);
    expect(screen.getByRole('button', { name: 'Hide the bet panel' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('mobile: the panel follows a drag down, springs back on a short one, and claims the gesture from the page', async () => {
    state.market = OPEN;
    renderPage(false);
    const panel = screen.getByRole('button', { name: 'Hide the bet panel' }).parentElement as HTMLElement;
    expect(panel.style.touchAction).toBe('none');
    await act(async () => {
      fireEvent.touchStart(panel, { touches: [{ clientY: 500 }] });
      fireEvent.touchMove(panel, { touches: [{ clientY: 530 }] });
    });
    expect(panel.style.transform).toBe('translateY(30px)');
    await act(async () => {
      fireEvent.touchEnd(panel, { changedTouches: [{ clientY: 530 }] });
    });
    expect(panel.style.transform).toBe('');
    expect(screen.getByRole('button', { name: 'Hide the bet panel' }), 'a 30px drag springs back').toBeTruthy();
    await act(async () => {
      fireEvent.touchStart(panel, { touches: [{ clientY: 500 }] });
      fireEvent.touchMove(panel, { touches: [{ clientY: 520 }] });
      fireEvent.touchCancel(panel);
    });
    expect(panel.style.transform, 'a cancelled gesture resets').toBe('');
  });

  it('mobile: a swipe down on the panel shrinks it, a swipe up opens it', async () => {
    state.market = OPEN;
    renderPage(false);
    const handle = screen.getByRole('button', { name: 'Hide the bet panel' });
    const panel = handle.parentElement as HTMLElement;
    await act(async () => {
      fireEvent.touchStart(panel, { touches: [{ clientY: 500 }] });
      fireEvent.touchEnd(panel, { changedTouches: [{ clientY: 590 }] });
    });
    expect(screen.getByRole('button', { name: 'Show the bet panel' })).toBeTruthy();
    await act(async () => {
      fireEvent.touchStart(panel, { touches: [{ clientY: 590 }] });
      fireEvent.touchEnd(panel, { changedTouches: [{ clientY: 550 }] });
    });
    expect(screen.getByRole('button', { name: 'Hide the bet panel' })).toBeTruthy();
  });
});
