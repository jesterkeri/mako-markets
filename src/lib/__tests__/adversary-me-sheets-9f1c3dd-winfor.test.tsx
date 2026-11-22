// Adversary on 9f1c3dd (spec 4: the done tile and share buttons are the opening account's own, on every page using the
// transaction hooks). PoolClient keeps `winFor`, the account a won claim was opened for, as ONE page-level value. A
// opens and confirms a won claim (pending), B signs in and opens their own claim (which overwrites winFor with B),
// A returns and A's claim lands: A's done tile must still offer "Share your win" for the claim A confirmed.
// Real usePoolTx on the real pool page; only runSponsoredRequest and the chain reads are stand-ins.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
const A = '0x00000000000000000000000000000000000000a5';
const B = '0x00000000000000000000000000000000000000b6';

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
let who = A;
vi.mock('wagmi', () => ({
  useReadContract: (q: { functionName?: string }) => ({ data: q.functionName === 'getUserBet' ? [10n * 1_000_000n, 0n, false] : undefined, refetch: vi.fn() }),
  useReadContracts: () => ({ data: undefined, refetch: vi.fn() }),
  useAccount: () => ({ address: undefined }),
  usePublicClient: () => ({ readContract: vi.fn(async () => 0n), waitForTransactionReceipt: vi.fn(async () => ({ status: 'success', logs: [] })) }),
  useWriteContract: () => ({ writeContractAsync: vi.fn() }),
}));
vi.mock('@/lib/hooks', () => ({
  useMarket: () => ({ market: SETTLED, isLoading: false, isError: false, refetch: vi.fn() }),
  useMarkets: () => ({ markets: [SETTLED] }),
  useUsdcBalance: () => ({ data: undefined, refetch: vi.fn() }),
  useEnsureMonadChain: () => vi.fn(),
  decodeMarket: vi.fn(),
}));
vi.mock('@/lib/use-user', () => ({
  useUser: () => ({ user: { authed: true, authType: 'magic', email: `${who}@example.com`, safeAddress: who, magicEoa: who, displayName: null, avatarUrl: null }, isLoading: false, isError: false, refetch: vi.fn() }),
  accountAddress: (u: { safeAddress: string }) => u.safeAddress,
}));
const sends = vi.hoisted(() => ({ list: [] as { eoa: string; resolve: (o: unknown) => void }[] }));
vi.mock('@/lib/aa-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/aa-client')>('@/lib/aa-client');
  return { ...actual, runSponsoredRequest: vi.fn((_b: unknown, eoa: string) => new Promise((resolve) => sends.list.push({ eoa, resolve }))) };
});

const { PoolClient } = await import('@/app/pools/[id]/PoolClient');

beforeEach(() => {
  who = A;
  sends.list = [];
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ bets: [] }), { status: 200 }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const tree = () => <PoolClient id={7n} initialSide={null} />;

describe('Pool page: A confirms a won claim, B opens their own claim, A returns', () => {
  it('control: with no other account in between, the landed claim offers Share your win', async () => {
    render(tree());
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /^Claim [\d.]+ USDC$/ })[0]);
    });
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /^Confirm/ })[0]);
    });
    await act(async () => sends.list[0].resolve({ kind: 'sent', txHash: `0x${'22'.repeat(32)}` }));
    expect(screen.queryAllByRole('button', { name: 'Share your win' }).length).toBeGreaterThan(0);
  });

  it("A's landed claim still offers Share your win", async () => {
    const r = render(tree());
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /^Claim [\d.]+ USDC$/ })[0]);
    });
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /^Confirm/ })[0]);
    });
    expect(sends.list.map((s) => s.eoa)).toEqual([A]);

    who = B;
    r.rerender(tree());
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /^Claim [\d.]+ USDC$/ })[0]);
    });
    // B has their own claim sheet in review; nothing of A's is in it.
    expect(screen.getAllByRole('button', { name: /^Confirm/ }).length).toBeGreaterThan(0);

    who = A;
    r.rerender(tree());
    await act(async () => sends.list[0].resolve({ kind: 'sent', txHash: `0x${'22'.repeat(32)}` }));
    expect(screen.getAllByText('You won').length).toBeGreaterThan(0);
    expect(screen.queryAllByRole('button', { name: 'Share your win' }).length).toBeGreaterThan(0);
  });
});
