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

// The transaction hooks: open records the sheet; landers[kind]() lands every instance whose sheet is open (fires its
// latest onLanded with the account that opened the sheet, as the real hooks do when a claim is mined). Other components
// on the page use the same hooks with no sheet open.
const open = { pool: new Map<object, () => void>(), round: new Map<object, () => void>() };
const landers: Record<'pool' | 'round', () => void> = {
  pool: () => [...open.pool.values()].forEach((f) => f()),
  round: () => [...open.round.values()].forEach((f) => f()),
};
function fakeTx(kind: 'pool' | 'round') {
  return async () => {
    const R = await import('react');
    return (onLanded?: (account: string) => void) => {
      const [tx, setTx] = R.useState<unknown>(null);
      const opener = R.useRef('');
      const latest = R.useRef(onLanded);
      R.useEffect(() => {
        latest.current = onLanded;
      });
      const [self] = R.useState(() => ({}));
      R.useEffect(() => {
        if (tx === null) return;
        open[kind].set(self, () => {
          latest.current?.(opener.current);
          setTx(null);
        });
        return () => void open[kind].delete(self);
      }, [tx, self]);
      const [spec, setSpec] = R.useState<unknown>(null);
      return { tx, phase: { step: 'pending' }, spec, createdId: undefined, open: (t: unknown, sheet?: unknown) => { opener.current = who; setSpec(sheet ?? null); setTx(t); }, close: () => setTx(null), confirm: vi.fn(), retry: vi.fn() };
    };
  };
}
vi.mock('@/lib/use-round-tx', async () => ({ useRoundTx: await fakeTx('round')() }));
vi.mock('@/lib/use-pool-tx', async () => ({ usePoolTx: await fakeTx('pool')() }));

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
  usePublicClient: () => ({ readContract: vi.fn() }),
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
vi.mock('@/lib/aa-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/aa-client')>('@/lib/aa-client');
  return { ...actual, runSponsoredRequest: vi.fn() };
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
const claimedRows = () => screen.queryAllByText(/Claimed/);

async function claim(label: RegExp, kind: 'pool' | 'round') {
  await act(async () => {
    fireEvent.click(screen.getAllByRole('button', { name: label })[0]);
  });
  await act(async () => {
    landers[kind]();
  });
}

beforeEach(() => {
  who = A;
  resetCreatorClaimHolds();
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Codex ME_ROUNDS_DEGRADE R2 F1: landed claims are scoped to the account', () => {
  it("A's landed pool and round claims never show for B, and B's own claims on the same ids stay claimable", async () => {
    // B's view on a fresh page, the reference.
    who = B;
    renderMe();
    const bFresh = claimLabels();
    expect(bFresh).toHaveLength(2);
    cleanup();

    who = A;
    const page = renderMe();
    const aLabels = claimLabels();
    expect(aLabels).toHaveLength(2);
    const [first, second] = aLabels;
    await claim(new RegExp(`^${first!.replace(/[.]/g, '\\.')}$`), first!.includes('3.86') ? 'round' : 'pool');
    await claim(new RegExp(`^${second!.replace(/[.]/g, '\\.')}$`), second!.includes('3.86') ? 'round' : 'pool');
    // Both of A's claims landed: no Claim button left for A, two "Claimed" rows.
    expect(claimLabels()).toEqual([]);
    expect(claimedRows().length).toBeGreaterThan(0);

    page.switchTo(B);
    expect(claimedRows()).toHaveLength(0);
    expect(claimLabels()).toEqual(bFresh);
  });

  it('a claim A opened that lands after B signed in is not recorded for B', async () => {
    const page = renderMe();
    const roundLabel = claimLabels().find((l) => l!.includes('3.86'));
    expect(roundLabel).toBeDefined();
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: roundLabel! })[0]);
    });

    page.switchTo(B);
    const bBefore = claimLabels();
    expect(bBefore).toHaveLength(2);
    await act(async () => {
      landers.round();
    });
    expect(claimedRows()).toHaveLength(0);
    expect(claimLabels()).toEqual(bBefore);
  });
});
