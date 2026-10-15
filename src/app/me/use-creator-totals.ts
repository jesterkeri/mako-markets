'use client';

import { useCreatorClaimHolds } from '@/lib/creator-claim-pending';
import { creatorEarningsFor } from '@/lib/creator-earnings';
import { useAllMarkets } from '@/lib/hooks';
import { usdc2 } from '@/lib/pool-list';

import type { Loadable } from './MeParts';

export type CreatorTotals = {
  /// Creator fees this account can collect now.
  unclaimed: bigint;
  /// Creator fees the chain shows this account already collected.
  claimed: bigint;
  /// Fee-bearing pools this account created (any state).
  pools: number;
};

/// Me's Creator earnings card: the same every-pool chain read the Creator earnings section uses (useAllMarkets, one
/// cached query, no extra RPC), summed by src/lib/creator-earnings.ts. A failed read with nothing read before is an
/// error, never zeros.
export function useCreatorTotals(account: string): Loadable<CreatorTotals> {
  const q = useAllMarkets();
  const holds = useCreatorClaimHolds();
  if (q.isError) return { status: 'error' }; // useAllMarkets: every retry failed and nothing was read
  if (q.isLoading) return { status: 'loading' };
  const e = creatorEarningsFor(q.markets, account, (id) => holds.has(id.toString()));
  return { status: 'ready', value: { unclaimed: e.claimableTotal, claimed: e.claimedTotal, pools: e.rows.length } };
}

/// Where the card leads: the Creator earnings list when there is one, otherwise creating a first pool. Me renders both
/// layouts (CSS shows one), so each has its own anchor; one shared id would send the mobile tile to the hidden desktop
/// list.
export const CREATOR_EARNINGS_ANCHOR = { desktop: 'creator-earnings', mobile: 'creator-earnings-mobile' } as const;

/// The card's accessible name, with its figures (an aria-label replaces the visible text for screen readers).
export function creatorTotalsLabel(t: CreatorTotals): string {
  return t.pools > 0
    ? `Creator earnings: ${usdc2(t.unclaimed)} USDC to claim, ${usdc2(t.claimed)} USDC claimed. See the list`
    : 'Creator earnings: none yet. Create a pool to earn';
}
