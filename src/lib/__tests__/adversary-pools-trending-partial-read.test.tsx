// @vitest-environment jsdom
// Adversary (2026-10-15), spec 1: "Mako Market's own pools (V4 MarketType.MAKO) always appear in Trending ... Honest
// empty state." useMarkets drops a pool whose own getMarket read failed and reports it only as `markets.length <
// count` (src/lib/hooks.ts). Home's Mako markets column treats that as a failed read (home-mako-markets.test.tsx,
// "a short line on a failed read"). The Pools page's Trending tab, fed the same partial read, must not present a list
// without the Mako Market pool, or "No pools open right now", as if it were the whole truth.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, within } from '@testing-library/react';
import * as React from 'react';

import { MarketType, Outcome, type MarketWithId } from '@/lib/contract';

const USDC = 1_000_000n;
const NOW = 1_800_000_000;
const HOUR = 3_600;

function pool(id: bigint, over: Partial<MarketWithId> = {}): MarketWithId {
  return {
    id,
    creator: '0x00000000000000000000000000000000000000c1',
    mType: MarketType.CRYPTO,
    oracleRef: `0x${'00'.repeat(32)}`,
    question: `Question ${id}?`,
    createdAt: BigInt(NOW - 10 * HOUR),
    closeTime: BigInt(NOW + 30 * HOUR),
    bettingCloseTime: BigInt(NOW + 29 * HOUR),
    totalYes: 3n * USDC,
    totalNo: 1n * USDC,
    yesBettorCount: 1,
    noBettorCount: 1,
    outcome: Outcome.UNRESOLVED,
    resolved: false,
    creatorFeeClaimed: false,
    protocolFeeBpsSnapshot: 100,
    creatorFeeBpsSnapshot: 200,
    ...over,
  };
}

let marketsState: { markets: MarketWithId[]; count: number; isLoading: boolean; isError: boolean; refetch: () => void };
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('@/lib/hooks', () => ({ useMarkets: () => marketsState }));
vi.mock('@/lib/use-live-clock', () => ({ useLiveNowSec: () => NOW }));
vi.mock('@/lib/use-user', () => ({ useUser: () => ({ user: null }), accountAddress: () => null }));
vi.mock('@/lib/use-user-bets', () => ({ useUserBets: () => new Map() }));
vi.mock('@/lib/use-pool-labels', () => ({ usePoolLabels: () => () => ({ yes: 'YES', no: 'NO' }) }));
vi.mock('@/lib/use-address-names', () => ({ useAddressNames: () => new Map() }));
vi.mock('@/components/Mascot', () => ({ Mascot: () => null }));

const { PoolsClient } = await import('@/app/pools/PoolsClient');

afterEach(cleanup);

// Pool #1 is an open Mako Market pool whose getMarket read failed: useMarkets returns only #0, with count 2.
function renderPartial(markets: MarketWithId[], count: number) {
  marketsState = { markets, count, isLoading: false, isError: false, refetch: () => {} };
  const { container } = render(<PoolsClient />);
  return { desk: container.querySelector('.mk-desk') as HTMLElement, mob: container.querySelector('.mk-mob') as HTMLElement };
}

describe('Trending on a partial chain read', () => {
  it('does not show a Trending list missing the Mako Market pool as if complete', () => {
    const { desk, mob } = renderPartial([pool(0n, { question: 'Ordinary pool?' })], 2);
    for (const layout of [desk, mob]) {
      // The Mako Market pool cannot be shown, so the page must say the read failed rather than list without it.
      expect(within(layout).queryByRole('region', { name: 'Trending' })).toBeNull();
      expect(within(layout).getByRole('button', { name: 'Try again' })).toBeTruthy();
    }
  });

  it('does not claim no pools are open when the only open pool failed to read', () => {
    const { desk, mob } = renderPartial([], 1);
    for (const layout of [desk, mob]) {
      expect(layout.textContent).not.toContain('No pools open right now');
    }
  });
});
