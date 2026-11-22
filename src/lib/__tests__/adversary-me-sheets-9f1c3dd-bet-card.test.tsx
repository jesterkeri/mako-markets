// Adversary on 9f1c3dd (spec 4: no account ever sees another account's result or share card, on every page using the
// transaction hooks). PoolClient keeps the bet card opened by a placed bet's "Share your call" as page state
// (`betCard`) with no account scope: the account card (`myCardFor`) is reset when the account changes, this one is not.
// A bets, taps Share your call (A's bet card opens), B signs in on the same mounted page: B must not be shown A's card.
// The tx hook is a stand-in already on its done step (the card state is the page's, not the hook's).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';

import { MarketType, Outcome, type MarketWithId } from '@/lib/contract';

vi.mock('@/lib/use-pool-tx', async () => {
  const R = await import('react');
  return {
    usePoolTx: () => {
      const [tx, setTx] = R.useState<unknown>(null);
      const [spec, setSpec] = R.useState<unknown>(null);
      return { tx, spec, phase: tx ? { step: 'done', txHash: `0x${'c'.repeat(64)}` } : { step: 'review' }, createdId: undefined, open: (t: unknown, s?: unknown) => { setSpec(s ?? null); setTx(t); }, close: () => setTx(null), confirm: vi.fn(), retry: vi.fn() };
    },
  };
});
vi.mock('@/components/PnlShareSheet', async (orig) => ({
  ...(await orig<typeof import('@/components/PnlShareSheet')>()),
  useBetLog: () => ({ status: 'found', log: 3 }),
  BetCardSheet: ({ tx, log }: { tx: string; log: number }) => <div role="dialog" aria-label="Bet card">{`${tx} log ${log}`}</div>,
}));
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
const A = '0x00000000000000000000000000000000000000a5';
const B = '0x00000000000000000000000000000000000000b6';
const OPEN: MarketWithId = {
  id: 7n,
  creator: '0x00000000000000000000000000000000000000c1',
  mType: MarketType.CRYPTO,
  oracleRef: '0x4254433a67743a31000000000000000000000000000000000000000000000000',
  question: 'Will BTC close above $80,000 in 1 day?',
  createdAt: BigInt(NOW - 3600),
  closeTime: BigInt(NOW + 24 * 3600),
  bettingCloseTime: BigInt(NOW + 20 * 3600),
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
let who = A;
vi.mock('wagmi', () => ({
  useReadContract: () => ({ data: undefined, refetch: vi.fn() }),
  useReadContracts: () => ({ data: undefined, refetch: vi.fn() }),
  useAccount: () => ({ address: undefined }),
  usePublicClient: () => ({ readContract: vi.fn() }),
  useWriteContract: () => ({ writeContractAsync: vi.fn() }),
}));
vi.mock('@/lib/hooks', () => ({
  useMarket: () => ({ market: OPEN, isLoading: false, isError: false, refetch: vi.fn() }),
  useMarkets: () => ({ markets: [OPEN] }),
  useUsdcBalance: () => ({ data: 100n * 1_000_000n, refetch: vi.fn() }),
  useEnsureMonadChain: () => vi.fn(),
}));
vi.mock('@/lib/use-user', () => ({
  useUser: () => ({ user: { authed: true, authType: 'wallet', walletAddress: who, displayName: null, avatarUrl: null, lastSignInAt: null } }),
  accountAddress: (u: { walletAddress: string }) => u.walletAddress,
}));

const { PoolClient } = await import('@/app/pools/[id]/PoolClient');

afterEach(() => {
  who = A;
  cleanup();
  vi.restoreAllMocks();
});

describe("Pool page: A's bet card is open, B signs in", () => {
  it("B is not shown A's bet card", async () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
    const tree = () => <PoolClient id={7n} initialSide={null} />;
    const r = render(tree());
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /^Bet / })[0]);
    });
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Share your call' })[0]);
    });
    expect(screen.queryAllByRole('dialog', { name: 'Bet card' }).length).toBeGreaterThan(0);

    who = B;
    r.rerender(tree());
    expect(screen.queryAllByRole('dialog', { name: 'Bet card' })).toHaveLength(0);
  });
});
