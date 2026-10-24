// The pool page's Share opens the signed-in account's own card when it holds a bet in the pool (Joshua 2026-10-24):
// bet placed while the pool is unsettled, the result once won or lost, with a link to the pool's invite. No stake, a
// refund or no account keeps the pool's invite.

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
const OPEN: MarketWithId = { ...SETTLED, closeTime: BigInt(NOW + 2 * 86400), bettingCloseTime: BigInt(NOW + 86400), outcome: Outcome.UNRESOLVED, resolved: false };
const REFUNDED: MarketWithId = { ...SETTLED, outcome: Outcome.REFUND };

const state = vi.hoisted(() => ({ market: null as unknown, bet: null as unknown, signedIn: true }));

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
    user: state.signedIn ? { authed: true, authType: 'wallet', walletAddress: ACCOUNT, displayName: null, avatarUrl: null, lastSignInAt: null } : null,
  }),
  accountAddress: () => ACCOUNT,
}));

const { PoolClient, poolCardState } = await import('@/app/pools/[id]/PoolClient');

afterEach(() => {
  state.market = null;
  state.bet = null;
  state.signedIn = true;
  cleanup();
  vi.restoreAllMocks();
});

/// The account's bets on the pool, as /api/me/bets answers them; they add up to the stake read on chain.
function serveBets(rows: { isYes: boolean; amount: bigint }[]) {
  const bets = rows.map((r, i) => ({ tx: `0x${String(i + 1).padStart(64, 'b')}`, log: i, isYes: r.isYes, amount: r.amount.toString(), at: NOW - 5000 }));
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ bets }), { status: 200 }));
}

async function openShare() {
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
  render(<PoolClient id={7n} initialSide={null} />);
  await act(async () => {
    fireEvent.click(screen.getAllByRole('button', { name: 'SHARE ↗' })[0]);
  });
}

describe('pool page Share: the account’s own card', () => {
  it('a winning bet on a settled pool opens the result card, which links to the pool’s invite', async () => {
    state.bet = [10n * USDC, 0n, false];
    const fetch = serveBets([{ isYes: true, amount: 10n * USDC }]);
    await openShare();
    expect(screen.getAllByRole('dialog', { name: 'Share your result' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('dialog', { name: 'Share' })).toBeNull();
    expect(String(fetch.mock.calls[0][0])).toBe(`/api/me/bets?account=${ACCOUNT}&pool=7`);
    const img = (await screen.findAllByRole('img', { name: /Your share card/ }))[0];
    expect(img.getAttribute('src')).toBe(`/pools/7/pnl/0x${'1'.padStart(64, 'b')}/0/result/image.png`);

    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Share the pool instead →' })[0]);
    });
    expect(screen.queryByRole('dialog', { name: 'Share your result' })).toBeNull();
    expect(screen.getAllByRole('dialog', { name: 'Share' }).length).toBeGreaterThan(0);
  });

  it('a losing bet opens the result card too', async () => {
    state.bet = [0n, 4n * USDC, false];
    serveBets([{ isYes: false, amount: 4n * USDC }]);
    await openShare();
    expect(screen.getAllByRole('dialog', { name: 'Share your result' }).length).toBeGreaterThan(0);
  });

  it('a bet on an open pool opens the bet placed card', async () => {
    state.market = OPEN;
    state.bet = [2n * USDC, 0n, false];
    serveBets([{ isYes: true, amount: 2n * USDC }]);
    await openShare();
    expect(screen.getAllByRole('dialog', { name: 'Share your call' }).length).toBeGreaterThan(0);
    const img = (await screen.findAllByRole('img', { name: /Your share card/ }))[0];
    expect(img.getAttribute('src')).toMatch(/\/placed\/image\.png$/);
  });

  it('no stake, a refund, or no account keeps the pool’s invite', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    state.bet = [0n, 0n, false];
    await openShare();
    expect(screen.getAllByRole('dialog', { name: 'Share' }).length).toBeGreaterThan(0);
    cleanup();

    state.market = REFUNDED;
    state.bet = [3n * USDC, 0n, false];
    await openShare();
    expect(screen.getAllByRole('dialog', { name: 'Share' }).length).toBeGreaterThan(0);
    cleanup();

    state.market = SETTLED;
    state.signedIn = false;
    state.bet = undefined;
    await openShare();
    expect(screen.getAllByRole('dialog', { name: 'Share' }).length).toBeGreaterThan(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('poolCardState', () => {
  it('picks the card as Me does', () => {
    expect(poolCardState(null, false)).toBeNull();
    expect(poolCardState({ kind: 'staked', yes: 1n, no: 0n }, false)).toBe('placed');
    expect(poolCardState({ kind: 'staked', yes: 1n, no: 0n }, true)).toBeNull();
    expect(poolCardState({ kind: 'won', amount: 2n, claimed: false }, true)).toBe('result');
    expect(poolCardState({ kind: 'won', amount: 2n, claimed: true }, true)).toBe('result');
    expect(poolCardState({ kind: 'lost', amount: 2n }, true)).toBe('result');
    expect(poolCardState({ kind: 'refund', amount: 2n, claimed: false }, true)).toBeNull();
  });
});
