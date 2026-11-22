// Adversary on 81d2060 (real usePoolTx and useRoundTx, only the sponsor request is faked). Harness copied from
// me-landed-account-scope.test.tsx. Spec: "claims that landed, and any claim in progress, belong to the account that
// made them ... A's landed or in-progress claims must never hide or alter B's own pending claims". A claim sheet
// belongs to one account (use-pool-tx.ts: "a sheet, and the done step after it, belong to one account").
// Codex ME_ROUNDS_DEGRADE R2 F1: claims that landed from Me belong to the account that made them. Account A claims a
// pool and a round, then account B signs in on the same tab. B holds stakes in the SAME pool id and round id, so A's
// "Claimed" rows must not show for B, and must not hide B's own pending claims. A claim A opened that lands after B
// signed in must not be recorded for B either.

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
const A = '0x00000000000000000000000000000000000000a5';
const B = '0x00000000000000000000000000000000000000b6';

// Pool 10, settled YES, created by someone else; both accounts bet YES on it.
const MARKETS: MarketWithId[] = [
  {
    id: 10n,
    creator: '0x00000000000000000000000000000000000000c1',
    mType: MarketType.CRYPTO,
    oracleRef: `0x${'00'.repeat(32)}`,
    question: 'Shared pool?',
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
const BETS: Record<string, readonly [bigint, bigint, boolean]> = { [A]: [1n * USDC, 0n, false], [B]: [3n * USDC, 0n, false] };

// Round 5, settled UP, hosted by someone else; both accounts backed UP.
const ROUND: Round = {
  id: 5n,
  creator: '0x00000000000000000000000000000000000000c2',
  openTime: NOW - 3 * 3600,
  startTime: NOW - 2 * 3600,
  status: RoundStatus.Settled,
  outcome: RoundOutcome.Up,
  refundReason: RefundReason.None,
  anchorPrice: 60_000n * 10n ** 18n,
  closePrice: 61_000n * 10n ** 18n,
  upPool: 10n * USDC,
  downPool: 10n * USDC,
  upEntrants: 2,
  downEntrants: 1,
  protocolFee: 200_000n,
  creatorFee: 500_000n,
  distributable: 19_300_000n,
};
const ROUND_STAKES: Record<string, bigint> = { [A]: 2n * USDC, [B]: 4n * USDC };

vi.mock('wagmi', () => ({
  useReadContracts: ({ contracts }: { contracts: { args: readonly [bigint, string] }[] }) => ({
    data: contracts.map((c) => BETS[c.args[1].toLowerCase()] ?? [0n, 0n, false]),
    isError: false,
    refetch: vi.fn(),
  }),
  useAccount: () => ({ address: undefined }),
  usePublicClient: () => ({ readContract: vi.fn(async () => 0n), waitForTransactionReceipt: vi.fn() }),
  useWriteContract: () => ({ writeContractAsync: vi.fn() }),
}));
vi.mock('@/lib/use-me-rounds', () => ({
  useMeRounds: (account: string) => ({
    status: 'ready',
    rounds: [ROUND],
    stakes: new Map([['5', { stake: { side: 'up', amount: ROUND_STAKES[account.toLowerCase()] ?? 0n }, claimed: false, creatorFeeClaimed: false }]]),
    refetch: vi.fn(),
  }),
}));
vi.mock('@/lib/hooks', () => ({
  useAllMarkets: () => ({ markets: MARKETS, count: MARKETS.length, isLoading: false, isError: false, refetch: vi.fn() }),
  useUsdcBalance: () => ({ data: 50n * USDC, isError: false, refetch: vi.fn() }),
  useEnsureMonadChain: () => vi.fn(),
}));
let who = A;
vi.mock('@/lib/use-user', () => ({
  USER_QUERY_KEY: ['user'],
  useUser: () => ({
    user: { authed: true, authType: 'magic', email: `${who}@example.com`, safeAddress: who, magicEoa: who, displayName: null, avatarUrl: null },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  accountAddress: (u: { safeAddress: string }) => u.safeAddress,
}));
const sponsor = vi.hoisted(() => ({ resolve: null as null | ((o: unknown) => void), calls: 0 }));
vi.mock('@/lib/aa-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/aa-client')>('@/lib/aa-client');
  return {
    ...actual,
    runSponsoredRequest: vi.fn(() => {
      sponsor.calls += 1;
      return new Promise((res) => {
        sponsor.resolve = res;
      });
    }),
  };
});

const { MeClient } = await import('@/app/me/MeClient');

const qc = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
function renderMe() {
  const client = qc();
  const tree = () => (
    <QueryClientProvider client={client}>
      <MeClient />
    </QueryClientProvider>
  );
  const r = render(tree());
  return { switchTo: (acct: string) => { who = acct; r.rerender(tree()); } };
}

/// The Claim buttons on screen, one entry per distinct label (each layout may render its own copy).
const claimLabels = () => [...new Set(screen.queryAllByRole('button', { name: /^Claim / }).map((b) => b.textContent))].sort();
const sheetShown = () => screen.queryAllByText(/^Claiming your/).length > 0;

beforeEach(() => {
  who = A;
  sponsor.resolve = null;
  sponsor.calls = 0;
  resetCreatorClaimHolds();
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function startClaimAsA(label: string) {
  const page = renderMe();
  await act(async () => {
    fireEvent.click(screen.getAllByRole('button', { name: label })[0]);
  });
  await act(async () => {
    fireEvent.click(screen.getAllByRole('button', { name: /^Confirm/ })[0]);
  });
  // A's claim is on its way: the sheet shows its pending step.
  expect(sponsor.calls).toBe(1);
  expect(sheetShown()).toBe(true);
  return page;
}

describe('adversary 81d2060: an in-progress claim belongs to the account that sent it', () => {
  it("A's in-flight POOL claim sheet is not shown to B (same pool id 10), and its landing is not recorded for B", async () => {
    const page = await startClaimAsA('Claim 1.29 USDC');
    page.switchTo(B);
    // B sees B's own claimable rows, not A's "Claiming your winnings" sheet for A's payout.
    expect(claimLabels()).toEqual(['Claim 3.88 USDC', 'Claim 7.72 USDC']);
    expect(sheetShown()).toBe(false);
    await act(async () => {
      sponsor.resolve!({ kind: 'sent', txHash: `0x${'11'.repeat(32)}` });
    });
    expect(screen.queryAllByText(/Claimed/)).toHaveLength(0);
    expect(claimLabels()).toEqual(['Claim 3.88 USDC', 'Claim 7.72 USDC']);
  });
});
