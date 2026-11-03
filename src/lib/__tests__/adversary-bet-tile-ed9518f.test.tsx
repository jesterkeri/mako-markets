// Adversary pass on ed9518f (pool page Share opens the account's own card). Spec (owner, 2026-10-24) item 2: Share
// opens "the bet placed card while the pool is unsettled, the win or loss card once settled", and which card "matches
// Me's rule (cardStateOf in PnlShareSheet.tsx and docs/pnl-share-card/SPEC.md: refunded or voided positions get no
// card)". Me's PnlShareButton recomputes the card from the position on every render, so a pool that settles while its
// sheet is open switches to the result card, or (refund) drops the sheet. These tests settle the pool while the pool
// page's card sheet is open and check the sheet follows the same rule.

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

// Open for betting, then the same pool once the resolver lands: YES won, or refunded.
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
const WON_YES: MarketWithId = { ...OPEN, closeTime: BigInt(NOW - 3600), bettingCloseTime: BigInt(NOW - 2 * 3600), outcome: Outcome.YES, resolved: true };
const REFUNDED: MarketWithId = { ...WON_YES, outcome: Outcome.REFUND };

const state = vi.hoisted(() => ({ market: null as unknown, bet: null as unknown }));

vi.mock('wagmi', () => ({
  useReadContract: (q: { functionName?: string }) => ({ data: q.functionName === 'getUserBet' ? state.bet : undefined, refetch: vi.fn() }),
  useReadContracts: () => ({ data: undefined, refetch: vi.fn() }),
  useAccount: () => ({ address: undefined }),
  usePublicClient: () => ({ readContract: vi.fn() }),
  useWriteContract: () => ({ writeContractAsync: vi.fn() }),
}));
vi.mock('@/lib/hooks', () => ({
  useMarket: () => ({ market: state.market as MarketWithId, isLoading: false, isError: false, refetch: vi.fn() }),
  useMarkets: () => ({ markets: [state.market as MarketWithId] }),
  useUsdcBalance: () => ({ data: undefined, refetch: vi.fn() }),
  useEnsureMonadChain: () => vi.fn(),
}));
vi.mock('@/lib/use-user', () => ({
  useUser: () => ({ user: { authed: true, authType: 'wallet', walletAddress: ACCOUNT, displayName: null, avatarUrl: null, lastSignInAt: null } }),
  accountAddress: () => ACCOUNT,
}));

const { PoolClient } = await import('@/app/pools/[id]/PoolClient');

afterEach(() => {
  state.market = null;
  state.bet = null;
  cleanup();
  vi.restoreAllMocks();
});

/// The account's one bet on the pool, as /api/me/bets answers it (a fresh Response per call). It adds up to the stake
/// read on chain, so the sheet offers its card.
function serveOneBet(amount: bigint) {
  const bets = [{ tx: `0x${'1'.padStart(64, 'b')}`, log: 0, isYes: true, amount: amount.toString(), at: NOW - 5000 }];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ bets }), { status: 200 }));
}

/// Opens the pool page on the open pool, presses Share, waits for the bet placed card, then lets the pool settle.
async function openPlacedThenSettle(settled: MarketWithId) {
  state.market = OPEN;
  state.bet = [2n * USDC, 0n, false];
  serveOneBet(2n * USDC);
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
  const view = render(<PoolClient id={7n} initialSide={null} />);
  await act(async () => {
    fireEvent.click(screen.getAllByRole('button', { name: 'SHARE ↗' })[0]);
  });
  // Precondition: the open pool offers the bet placed card.
  const placed = (await screen.findAllByRole('img', { name: /Your share card/ }))[0];
  expect(placed.getAttribute('src')).toMatch(/\/placed\/image\.png$/);

  // The resolver lands while the sheet is open; the pool page's next read carries the settled pool.
  state.market = settled;
  await act(async () => {
    view.rerender(<PoolClient id={7n} initialSide={null} />);
  });
}

const cardSrcs = () => screen.queryAllByRole('img', { name: /Your share card/ }).map((i) => i.getAttribute('src') ?? '');

describe('adversary ed9518f: the pool page card sheet follows the pool when it settles while open', () => {
  it('a pool refunded while the sheet is open offers no card (Me: refunded positions get no card)', async () => {
    await openPlacedThenSettle(REFUNDED);
    expect(cardSrcs()).toEqual([]);
  });

  it('a pool won while the sheet is open no longer offers the bet placed card (spec: win or loss card once settled)', async () => {
    await openPlacedThenSettle(WON_YES);
    expect(cardSrcs().filter((s) => /\/placed\//.test(s))).toEqual([]);
  });

  // Control, passes today: Me's Share (the rule the spec names) does follow the pool, so the two above are a pool
  // page divergence, not a shared behaviour.
  it('control: Me’s Share drops the card when the pool is refunded and switches to the result when it is won', async () => {
    const { PnlShareButton } = await import('@/components/PnlShareSheet');
    const { mePositions } = await import('@/lib/me-stats');
    const bets = new Map([['7', { yes: 2n * USDC, no: 0n, claimed: false }]]);
    const pos = (m: MarketWithId) => mePositions([m], bets, NOW)[0];
    const labels = { yes: 'YES', no: 'NO' };
    serveOneBet(2n * USDC);
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);

    const view = render(<PnlShareButton p={pos(OPEN)} account={ACCOUNT} labels={labels} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Share your call/ }));
    });
    expect((await screen.findAllByRole('img', { name: /Your share card/ }))[0].getAttribute('src')).toMatch(/\/placed\//);

    await act(async () => {
      view.rerender(<PnlShareButton p={pos(WON_YES)} account={ACCOUNT} labels={labels} />);
    });
    expect(cardSrcs().filter((s) => /\/placed\//.test(s))).toEqual([]);

    await act(async () => {
      view.rerender(<PnlShareButton p={pos(REFUNDED)} account={ACCOUNT} labels={labels} />);
    });
    expect(cardSrcs()).toEqual([]);
  });
});
