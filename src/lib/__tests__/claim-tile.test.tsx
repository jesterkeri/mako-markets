// A claim's done tile on the pool page (Joshua 2026-10-24): black with the Mako mark like a placed bet, the amount in big
// type; a won pool's claim offers Share your win, which opens the win card; a refund gets the tile and no card.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';

import { MarketType, Outcome, type MarketWithId } from '@/lib/contract';

// The transaction lands the moment it opens: this file tests the done sheet, not the send.
vi.mock('@/lib/use-pool-tx', async () => {
  const R = await import('react');
  return {
    usePoolTx: () => {
      const [tx, setTx] = R.useState<unknown>(null);
      return { tx, phase: { step: 'done', txHash: `0x${'c'.repeat(64)}` }, createdId: undefined, open: setTx, close: () => setTx(null), confirm: vi.fn(), retry: vi.fn() };
    },
  };
});
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
const ACCOUNT = '0x00000000000000000000000000000000000000a1';

const SETTLED: MarketWithId = {
  id: 7n,
  creator: '0x00000000000000000000000000000000000000c1',
  mType: MarketType.CRYPTO,
  oracleRef: '0x4254433a67743a31000000000000000000000000000000000000000000000000',
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
const REFUNDED: MarketWithId = { ...SETTLED, outcome: Outcome.REFUND };

const state = vi.hoisted(() => ({ market: null as unknown, bet: null as unknown, signedIn: true, account: '0x00000000000000000000000000000000000000a1' }));

vi.mock('wagmi', () => ({
  useReadContract: (q: { functionName?: string }) => ({ data: q.functionName === 'getUserBet' ? state.bet : undefined, refetch: vi.fn() }),
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
  useUser: () => ({
    user: state.signedIn ? { authed: true, authType: 'wallet', walletAddress: state.account, displayName: null, avatarUrl: null, lastSignInAt: null } : null,
  }),
  accountAddress: (u: { walletAddress: string }) => u.walletAddress,
}));

const { PoolClient } = await import('@/app/pools/[id]/PoolClient');

afterEach(() => {
  state.market = null;
  state.bet = null;
  state.account = ACCOUNT;
  cleanup();
  vi.restoreAllMocks();
});

async function claim(name: RegExp) {
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
  const view = render(<PoolClient id={7n} initialSide={null} />);
  await act(async () => {
    fireEvent.click(screen.getAllByRole('button', { name })[0]);
  });
  return view;
}

const tileOf = (text: string) => screen.getAllByText(text)[0].closest('.wl-tile') as HTMLElement;

describe('pool page claim tile', () => {
  it('a won claim shows the black tile and shares the win card', async () => {
    state.bet = [10n * USDC, 0n, false];
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ bets: [] }), { status: 200 }));
    await claim(/^Claim [\d.]+ USDC$/);
    expect(screen.getAllByText('You won').length).toBeGreaterThan(0);
    expect(screen.getAllByText('In your balance.').length).toBeGreaterThan(0);
    const tile = tileOf('In your balance.');
    expect(tile.style.background).toBe('#000');
    expect(tile.querySelector('[aria-hidden] svg')).not.toBeNull();

    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Share your win' })[0]);
    });
    expect(screen.queryByText('You won')).toBeNull();
    expect(screen.getAllByRole('dialog', { name: 'Share your result' }).length).toBeGreaterThan(0);
    expect(String(fetch.mock.calls[0][0])).toBe(`/api/me/bets?account=${ACCOUNT}&pool=7`);
  });

  it('a refund claim shows the black tile with no card to share', async () => {
    state.market = REFUNDED;
    state.bet = [2n * USDC, 0n, false];
    await claim(/^Claim refund/);
    expect(screen.getAllByText('Refund claimed').length).toBeGreaterThan(0);
    expect(screen.getAllByText('2.00 USDC').length).toBeGreaterThan(0);
    expect(tileOf('Your full stake is back in your balance.').style.background).toBe('#000');
    expect(screen.queryByRole('button', { name: 'Share your win' })).toBeNull();
  });

  it('another account signing in while the tile is up gets no Share, even when it won the pool too', async () => {
    state.bet = [10n * USDC, 0n, false];
    const view = await claim(/^Claim [\d.]+ USDC$/);
    expect(screen.getAllByRole('button', { name: 'Share your win' }).length).toBeGreaterThan(0);
    state.account = '0x00000000000000000000000000000000000000b2';
    view.rerender(<PoolClient id={7n} initialSide={null} />);
    expect(screen.queryByRole('button', { name: 'Share your win' })).toBeNull();
  });
});
