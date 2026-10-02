// The pool page (9a) opens Share (15a) from its receipt's share control, on desktop and on mobile, instead of
// copying the page's address; Escape closes it and focus goes back to the control that opened it.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';

import { MarketType, Outcome, type MarketWithId } from '@/lib/contract';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('notFound'); } }));
vi.mock('@/components/comments/PoolComments', () => ({ PoolCommentsDesktop: () => null, PoolCommentsMobile: () => null }));
vi.mock('@/lib/use-mako-labels', () => ({ useMakoLabels: () => ({ data: undefined }) }));
vi.mock('@/lib/use-address-names', () => ({ useAddressNames: () => new Map() }));

const USDC = 1_000_000n;
const NOW = Math.floor(Date.now() / 1000);

// Settled YES: the receipt (and its share control) shows.
const MARKET: MarketWithId = {
  id: 7n,
  creator: '0x00000000000000000000000000000000000000c1',
  mType: MarketType.CRYPTO,
  oracleRef: `0x${'00'.repeat(32)}`,
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

vi.mock('wagmi', () => ({
  useReadContract: () => ({ data: undefined, refetch: vi.fn() }),
  useReadContracts: () => ({ data: undefined, refetch: vi.fn() }),
  useAccount: () => ({ address: undefined }),
  usePublicClient: () => ({ readContract: vi.fn() }),
  useWriteContract: () => ({ writeContractAsync: vi.fn() }),
}));
vi.mock('@/lib/hooks', () => ({
  useMarket: () => ({ market: MARKET, isLoading: false, isError: false, refetch: vi.fn() }),
  useMarkets: () => ({ markets: [MARKET] }),
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

    const control = screen.getByRole('button', { name: 'SHARE ↗' });
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
});
