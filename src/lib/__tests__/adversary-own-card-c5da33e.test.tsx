// Adversary pass on c5da33e (the pool page's own-card sheet follows the pool and the account while open). Spec (owner,
// 2026-10-24) item 1: "The card shown must follow the pool and the account at all times while the sheet is open,
// exactly as Me's Share (PnlShareButton / cardStateOf in src/components/PnlShareSheet.tsx) does", and "Closing returns
// to the page normally". On Me, signing out unmounts the signed-in page (src/app/me/MeClient.tsx:76), so a card sheet
// that was open is gone for good: signing back in shows Me with no sheet until Share is pressed again. On the pool page
// c5da33e keeps `myCardFor` (the account the sheet was opened for) across a sign-out, so the sheet hides while signed
// out and opens again by itself when the same account signs back in, with no Share pressed.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';

import { MarketType, Outcome, type MarketWithId } from '@/lib/contract';

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

const OPEN: MarketWithId = {
  id: 7n,
  creator: '0x00000000000000000000000000000000000000c1',
  mType: MarketType.CRYPTO,
  oracleRef: '0x4254433a67743a31000000000000000000000000000000000000000000000000',
  question: 'Will BTC close above $80,000 in 1 day?',
  createdAt: BigInt(NOW - 10 * 3600),
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

const state = vi.hoisted(() => ({ signedIn: true }));

// getUserBet answers the account's stake while signed in; signed out the read is disabled and holds nothing.
vi.mock('wagmi', () => ({
  useReadContract: (q: { functionName?: string }) => ({
    data: q.functionName === 'getUserBet' && state.signedIn ? [2n * USDC, 0n, false] : undefined,
    refetch: vi.fn(),
  }),
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
  useUser: () => ({
    user: state.signedIn ? { authed: true, authType: 'wallet', walletAddress: ACCOUNT, displayName: null, avatarUrl: null, lastSignInAt: null } : null,
  }),
  accountAddress: () => ACCOUNT,
}));

const { PoolClient } = await import('@/app/pools/[id]/PoolClient');

afterEach(() => {
  state.signedIn = true;
  cleanup();
  vi.restoreAllMocks();
});

function serveOneBet() {
  const bets = [{ tx: `0x${'1'.padStart(64, 'b')}`, log: 0, isYes: true, amount: (2n * USDC).toString(), at: NOW - 5000 }];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ bets }), { status: 200 }));
}

const ownSheet = () => screen.queryAllByRole('dialog', { name: 'Share your call' });

describe('adversary c5da33e: the own-card sheet after the account signs out', () => {
  it('signing out then back in as the same account does not reopen the sheet without Share being pressed', async () => {
    serveOneBet();
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
    const view = render(<PoolClient id={7n} initialSide={null} />);
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'SHARE ↗' })[0]);
    });
    // Precondition: the account's bet placed card sheet is open.
    expect(ownSheet().length).toBeGreaterThan(0);

    // The session ends while the sheet is open: the sheet goes with it.
    state.signedIn = false;
    await act(async () => {
      view.rerender(<PoolClient id={7n} initialSide={null} />);
    });
    expect(ownSheet()).toEqual([]);

    // The same account signs back in on the page. Nobody pressed Share, so the page must be the plain page, as Me is.
    state.signedIn = true;
    await act(async () => {
      view.rerender(<PoolClient id={7n} initialSide={null} />);
    });
    expect(ownSheet()).toEqual([]);
  });
});
