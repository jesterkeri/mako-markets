// Codex ME_ROUNDS_DEGRADE R3 F1, through the REAL usePoolTx and useRoundTx (only the sponsor request is faked, each
// send kept pending until the test releases it). A starts a claim and it stays pending; B signs in on the same tab.
// B must be able to open AND complete its own claims, pool and round, crossing types and the same ids, and A's
// eventual result must not reach B's page. Harness from adversary-me-landed-scope-81d2060.test.tsx.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';

import { MarketType, Outcome, type MarketWithId } from '@/lib/contract';
import { resetCreatorClaimHolds } from '@/lib/creator-claim-pending';
import { RefundReason, RoundOutcome, RoundStatus, type Round } from '@/lib/rounds-model';

vi.mock('@/lib/contract', async (orig) => ({ ...(await orig<typeof import('@/lib/contract')>()), ROUNDS_ADDRESS: '0x00000000000000000000000000000000000000f0' }));
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
type Sent = { kind: string; eoa: string; resolve: (o: unknown) => void };
const sends = vi.hoisted(() => ({ list: [] as { kind: string; eoa: string; resolve: (o: unknown) => void }[] }));
vi.mock('@/lib/aa-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/aa-client')>('@/lib/aa-client');
  return {
    ...actual,
    runSponsoredRequest: vi.fn((body: { kind: string }, eoa: string) => new Promise((resolve) => sends.list.push({ kind: body.kind, eoa, resolve }))),
  };
});

const { MeClient } = await import('@/app/me/MeClient');

function renderMe() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = () => (
    <QueryClientProvider client={client}>
      <MeClient />
    </QueryClientProvider>
  );
  const r = render(tree());
  return { switchTo: (acct: string) => { who = acct; r.rerender(tree()); } };
}

const claimLabels = () => [...new Set(screen.queryAllByRole('button', { name: /^Claim / }).map((b) => b.textContent))].sort();
const claimedRows = () => [...new Set(screen.queryAllByText(/^✓ Claimed \d/).map((e) => e.textContent))].sort();
const land = async (s: Sent) => act(async () => s.resolve({ kind: 'sent', txHash: `0x${'11'.repeat(32)}` }));

async function claim(label: string) {
  await act(async () => {
    fireEvent.click(screen.getAllByRole('button', { name: label })[0]);
  });
  await act(async () => {
    fireEvent.click(screen.getAllByRole('button', { name: /^Confirm/ })[0]);
  });
}
async function closeSheet() {
  await act(async () => {
    const done = screen.queryAllByRole('button', { name: /^(Done|Close)$/ });
    if (done.length) fireEvent.click(done[0]);
  });
}

// A: pool 1.29, round 3.86. B: pool 3.88, round 7.72 (same pool id 10 and round id 5).
const A_POOL = 'Claim 1.29 USDC';
const A_ROUND = 'Claim 3.86 USDC';
const B_POOL = 'Claim 3.88 USDC';
const B_ROUND = 'Claim 7.72 USDC';

beforeEach(() => {
  who = A;
  sends.list = [];
  resetCreatorClaimHolds();
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe.each([
  ['pool', 'round', A_POOL, B_ROUND, 'round_claim'],
  ['round', 'pool', A_ROUND, B_POOL, 'claim'],
  ['pool', 'pool', A_POOL, B_POOL, 'claim'],
  ['round', 'round', A_ROUND, B_ROUND, 'round_claim'],
])("Codex R3 F1: A's %s claim pending, B claims a %s", (_aKind, _bKind, aLabel, bLabel, bSendKind) => {
  it('B opens and completes its own claim; A landing afterwards changes nothing on B\'s page', async () => {
    const page = renderMe();
    await claim(aLabel);
    expect(sends.list).toHaveLength(1);
    expect(sends.list[0].eoa).toBe(A);
    page.switchTo(B);
    expect(claimLabels()).toEqual([B_POOL, B_ROUND]);

    await claim(bLabel);
    // B's claim went out, as B, of B's kind
    expect(sends.list).toHaveLength(2);
    expect(sends.list[1]).toMatchObject({ eoa: B, kind: bSendKind });
    await land(sends.list[1]);
    await closeSheet();
    const bAmount = bLabel.replace('Claim ', '').replace(' USDC', '');
    expect(claimedRows()).toEqual([`✓ Claimed ${bAmount}`]);
    expect(claimLabels()).toEqual([B_POOL, B_ROUND].filter((l) => l !== bLabel));

    // A's send lands late: nothing about it on B's page
    await land(sends.list[0]);
    await closeSheet();
    expect(claimedRows()).toEqual([`✓ Claimed ${bAmount}`]);
    expect(claimLabels()).toEqual([B_POOL, B_ROUND].filter((l) => l !== bLabel));
    expect(screen.queryAllByText(/^Claiming your/)).toHaveLength(0);
  });
});
