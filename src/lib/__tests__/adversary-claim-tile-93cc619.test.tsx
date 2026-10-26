// Adversary pass on 93cc619 (claim done tile). Spec (owner, 2026-10-24) item 1 gives the black tile to four claims: a
// won pool, a refunded pool, a won round, a refunded round. Item 4: "creator-earnings claims keep their old plain tile".
// A round's host (creator) fee is claimed through the round's own claim; Me lists a round the account hosted with no
// stake "only for its creator fee" (src/lib/me-rounds.ts). That claim is creator earnings, neither a win nor a refund,
// yet roundClaimSpec (MeClient.tsx) and claimSpec (RoundClient.tsx) set doneTile for every round claim, so it gets the
// black win tile. Control: the pool creator-earnings claim from the same page keeps the plain tile.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';

import { MarketType, Outcome, type MarketWithId } from '@/lib/contract';
import { resetCreatorClaimHolds } from '@/lib/creator-claim-pending';
import { RefundReason, RoundOutcome, RoundStatus, type Round } from '@/lib/rounds-model';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('@/lib/use-mako-labels', () => ({ useMakoLabelsBatch: () => ({ data: undefined }) }));

const USDC = 1_000_000n;
const NOW = Math.floor(Date.now() / 1000);
const SAFE = '0x00000000000000000000000000000000000000a5';
const EOA = '0x00000000000000000000000000000000000000e0';
const TX = `0x${'cd'.repeat(32)}`;

// Both transactions land the moment they open: this file tests the done sheet, not the send.
vi.mock('@/lib/use-round-tx', async () => {
  const R = await import('react');
  return {
    useRoundTx: () => {
      const [tx, setTx] = R.useState<unknown>(null);
      return { tx, phase: { step: 'done', txHash: TX }, open: setTx, close: () => setTx(null), confirm: vi.fn(), retry: vi.fn() };
    },
  };
});
vi.mock('@/lib/use-pool-tx', async () => {
  const R = await import('react');
  return {
    usePoolTx: () => {
      const [tx, setTx] = R.useState<unknown>(null);
      return { tx, phase: { step: 'done', txHash: TX }, createdId: undefined, open: setTx, close: () => setTx(null), confirm: vi.fn(), retry: vi.fn() };
    },
  };
});

// One pool this account created, settled YES, 30/10 at 2%: 0.80 USDC of pool creator earnings (the control).
const MARKETS: MarketWithId[] = [
  {
    id: 10n,
    creator: SAFE,
    mType: MarketType.CRYPTO,
    oracleRef: `0x${'00'.repeat(32)}`,
    question: 'Hosted pool?',
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
  },
];

// Round 5, hosted by this account, settled; the account holds no stake in it, only the 0.50 USDC host fee to claim.
const ROUND: Round = {
  id: 5n,
  creator: SAFE,
  openTime: NOW - 3 * 3600,
  startTime: NOW - 2 * 3600,
  status: RoundStatus.Settled,
  outcome: RoundOutcome.Up,
  refundReason: RefundReason.None,
  anchorPrice: 60_000n * 10n ** 18n,
  closePrice: 61_000n * 10n ** 18n,
  upPool: 10n * USDC,
  downPool: 10n * USDC,
  upEntrants: 1,
  downEntrants: 1,
  protocolFee: 200_000n,
  creatorFee: 500_000n,
  distributable: 19_300_000n,
};

vi.mock('wagmi', () => ({
  useReadContracts: () => ({ data: [[0n, 0n, false]], isError: false, refetch: vi.fn() }),
  useAccount: () => ({ address: undefined }),
  usePublicClient: () => ({ readContract: vi.fn() }),
  useWriteContract: () => ({ writeContractAsync: vi.fn() }),
}));
vi.mock('@/lib/use-me-rounds', () => ({
  useMeRounds: () => ({
    status: 'ready',
    rounds: [ROUND],
    stakes: new Map([['5', { stake: { side: null, amount: 0n }, claimed: false, creatorFeeClaimed: false }]]),
    refetch: vi.fn(),
  }),
}));
vi.mock('@/lib/hooks', () => ({
  useAllMarkets: () => ({ markets: MARKETS, count: MARKETS.length, isLoading: false, isError: false, refetch: vi.fn() }),
  useUsdcBalance: () => ({ data: 50n * USDC, isError: false, refetch: vi.fn() }),
  useEnsureMonadChain: () => vi.fn(),
}));
vi.mock('@/lib/use-user', () => ({
  USER_QUERY_KEY: ['user'],
  useUser: () => ({
    user: { authed: true, authType: 'magic', email: 'j@example.com', safeAddress: SAFE, magicEoa: EOA, displayName: 'joshua', avatarUrl: null },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  accountAddress: (u: { safeAddress: string }) => u.safeAddress,
}));
vi.mock('@/lib/aa-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/aa-client')>('@/lib/aa-client');
  return { ...actual, runSponsoredRequest: vi.fn() };
});

const { MeClient } = await import('@/app/me/MeClient');

function renderMe() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MeClient />
    </QueryClientProvider>,
  );
}

/// The done step's tile (the sheet renders it once per layout; the first is enough).
const doneTile = () => document.querySelector<HTMLElement>('[role="dialog"] .wl-tile, .wl-tile')!;

beforeEach(() => {
  resetCreatorClaimHolds();
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('adversary 93cc619: creator-earnings claims keep their old plain tile', () => {
  it('control: the pool creator-earnings claim done tile is the plain one', async () => {
    renderMe();
    const claim = screen.getAllByRole('button', { name: /^Claim 0\.80/ });
    await act(async () => {
      fireEvent.click(claim[0]);
    });
    const tile = doneTile();
    expect(tile).not.toBeNull();
    expect(tile.style.background).toBe('var(--m3-inv)');
  });

  it('a round host-fee claim (no stake: creator earnings, not a win or a refund) keeps the plain tile', async () => {
    renderMe();
    const claim = screen.getAllByRole('button', { name: 'Claim 0.50 USDC' });
    await act(async () => {
      fireEvent.click(claim[0]);
    });
    const tile = doneTile();
    expect(tile).not.toBeNull();
    // Item 1 lists no host-fee claim among the black-tile claims; item 4 keeps creator earnings on the plain tile.
    expect(tile.style.background).toBe('var(--m3-inv)');
  });
});
