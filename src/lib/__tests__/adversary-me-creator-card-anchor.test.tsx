// Adversary pass on 03bbb76 (feat/me-creator-card). The spec: the Creator earnings card "leads to the Creator earnings
// list on the same layout". Me mounts that list only when its whole chain read (pools, stakes AND rounds) is ready,
// while the card reads pools alone, so a failed rounds or stake read leaves the card linking to an anchor that is not
// on the page. Harness copied from me-creator-totals.test.tsx.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';

import { MarketType, Outcome, type MarketWithId } from '@/lib/contract';
import { resetCreatorClaimHolds } from '@/lib/creator-claim-pending';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('@/lib/use-mako-labels', () => ({ useMakoLabelsBatch: () => ({ data: undefined }) }));

const USDC = 1_000_000n;
const NOW = Math.floor(Date.now() / 1000);
const SAFE = '0x00000000000000000000000000000000000000a5';
const EOA = '0x00000000000000000000000000000000000000e0';

function pool(id: bigint, over: Partial<MarketWithId>): MarketWithId {
  return {
    id,
    creator: '0x00000000000000000000000000000000000000c1',
    mType: MarketType.CRYPTO,
    oracleRef: `0x${'00'.repeat(32)}`,
    question: `Question ${id}?`,
    createdAt: BigInt(NOW - 10 * 3600),
    closeTime: BigInt(NOW - 3600),
    bettingCloseTime: BigInt(NOW - 2 * 3600),
    totalYes: 30n * USDC,
    totalNo: 10n * USDC,
    yesBettorCount: 2,
    noBettorCount: 1,
    outcome: Outcome.UNRESOLVED,
    resolved: false,
    creatorFeeClaimed: false,
    protocolFeeBpsSnapshot: 100,
    creatorFeeBpsSnapshot: 200,
    ...over,
  };
}

// One pool this account (SAFE) created, settled YES, 30/10 at 2%: 0.80 USDC claimable.
const MARKETS: MarketWithId[] = [pool(10n, { creator: SAFE, resolved: true, outcome: Outcome.YES, question: 'Claimable pool?' })];

type Bet = readonly [bigint, bigint, boolean];
let bets: Bet[] = [];
let betFails: 'none' | 'nothing-read' = 'none';
const marketsState = { markets: MARKETS, count: MARKETS.length, isLoading: false, isError: false };

vi.mock('wagmi', () => ({
  useReadContracts: () => ({ data: betFails === 'nothing-read' ? undefined : bets, isError: betFails !== 'none', refetch: vi.fn() }),
  useAccount: () => ({ address: undefined }),
  usePublicClient: () => ({ readContract: vi.fn() }),
  useWriteContract: () => ({ writeContractAsync: vi.fn() }),
}));
type RoundsRead = { status: 'off' } | { status: 'error' };
let roundsRead: RoundsRead = { status: 'off' };
vi.mock('@/lib/use-me-rounds', () => ({ useMeRounds: () => ({ ...roundsRead, refetch: vi.fn() }) }));

vi.mock('@/lib/hooks', () => ({
  useAllMarkets: () => ({ ...marketsState, refetch: vi.fn() }),
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

const layout = (which: 'desk' | 'mob') => document.querySelector<HTMLElement>(which === 'desk' ? '.mk-desk' : '.mk-mob')!;
const card = (which: 'desk' | 'mob') => within(layout(which)).queryByRole('link', { name: /^Creator earnings: / });

beforeEach(() => {
  roundsRead = { status: 'off' };
  betFails = 'none';
  bets = MARKETS.map(() => [0n, 0n, false] as const);
  resetCreatorClaimHolds();
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/// Where the card's link lands: `found` is false only for an in-page link whose id is not on its layout. A card that
/// is not a link at all (one way to fix this) passes.
function target(which: 'desk' | 'mob'): { href: string | null; found: boolean } {
  const link = card(which);
  if (!link) return { href: null, found: true };
  const href = link.getAttribute('href')!;
  return { href, found: !href.startsWith('#') || layout(which).querySelector(href) !== null };
}

describe('adversary: the Creator earnings card leads to a list that is on the page', () => {
  it('control: everything read, the anchor exists on both layouts', () => {
    renderMe();
    expect(target('desk')).toEqual({ href: '#creator-earnings', found: true });
    expect(target('mob')).toEqual({ href: '#creator-earnings-mobile', found: true });
  });

  for (const which of ['desk', 'mob'] as const) {
    it(`${which}: the rounds read failed (pool read fine): the card's anchor is on the page`, () => {
      roundsRead = { status: 'error' };
      renderMe();
      expect(target(which).found).toBe(true);
    });

    it(`${which}: the stake read failed with nothing read (pool read fine): the card's anchor is on the page`, () => {
      betFails = 'nothing-read';
      renderMe();
      expect(target(which).found).toBe(true);
    });
  }
});
