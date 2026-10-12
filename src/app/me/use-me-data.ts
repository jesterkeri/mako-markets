'use client';

import { useMemo } from 'react';
import { useReadContracts } from 'wagmi';

import { makoContract, MarketType } from '@/lib/contract';
import { useAllMarkets, useUsdcBalance } from '@/lib/hooks';
import { createdCount, mePositions, meStats, type MePosition, type MeStats } from '@/lib/me-stats';
import type { UserBet } from '@/lib/pool-list';
import { useMakoLabelsBatch } from '@/lib/use-mako-labels';

export type Labels = { yes: string; no: string };

export type MeChain =
  | { status: 'loading' }
  /// A read still failed after TanStack Query's retries, with nothing read before: the page shows the error, never
  /// zeros. A refetch that fails keeps showing the last complete reading.
  | { status: 'error' }
  | { status: 'ready'; positions: MePosition[]; stats: MeStats; created: number };

/// Everything Me reads from the chain for one account: every V4 pool, the account's stake in each (one multicall),
/// and its USDC balance. The balance is separate, so a failed balance read does not hide the positions. The pool and
/// stake reads are all-or-nothing (one refused call fails the read), so a refusal is retried instead of blanking
/// the totals.
export function useMeData(account: `0x${string}`, nowSec: number | null) {
  const marketsQ = useAllMarkets();
  const { markets } = marketsQ;
  const ids = useMemo(() => markets.map((m) => m.id), [markets]);
  const betsQ = useReadContracts({
    allowFailure: false,
    contracts: ids.map((id) => ({ ...makoContract, functionName: 'getUserBet' as const, args: [id, account] as const })),
    query: { enabled: ids.length > 0, refetchInterval: 10_000 },
  });
  const balanceQ = useUsdcBalance(account);

  const bets = useMemo(() => {
    const d = betsQ.data;
    if (!d || d.length !== ids.length) return null;
    const out = new Map<string, UserBet>();
    d.forEach((r, i) => {
      const [yes, no, claimed] = r as readonly [bigint, bigint, boolean];
      out.set(ids[i].toString(), { yes, no, claimed });
    });
    return out;
  }, [betsQ.data, ids]);

  let chain: MeChain;
  // Both reads are all-or-nothing, so a failure here is one that outlasted the retries with nothing read before.
  const betsFailed = betsQ.isError && !betsQ.data;
  if (marketsQ.isError || betsFailed) chain = { status: 'error' };
  else if (marketsQ.isLoading || nowSec === null || (ids.length > 0 && bets === null)) chain = { status: 'loading' };
  else {
    const positions = mePositions(markets, bets ?? new Map(), nowSec);
    chain = { status: 'ready', positions, stats: meStats(positions), created: createdCount(markets, account) };
  }

  // Custom outcome names for the house (MAKO) pools the account holds, keyed on the set of held pools so the clock
  // tick does not refetch them.
  const heldMako = chain.status === 'ready' ? chain.positions.filter((p) => p.market.mType === MarketType.MAKO).map((p) => p.market.id.toString()).join(',') : '';
  const makoIds = useMemo(() => (heldMako ? heldMako.split(',') : []), [heldMako]);
  const { data: makoLabels } = useMakoLabelsBatch(makoIds);
  const labelsOf = (p: MePosition): Labels => {
    const l = p.market.mType === MarketType.MAKO ? makoLabels?.get(p.market.id.toString()) : undefined;
    return l ? { yes: l.label1, no: l.label2 } : { yes: 'YES', no: 'NO' };
  };

  const balance: { status: 'loading' } | { status: 'error' } | { status: 'ready'; value: bigint } =
    typeof balanceQ.data === 'bigint' ? { status: 'ready', value: balanceQ.data } : balanceQ.isError ? { status: 'error' } : { status: 'loading' };

  const refetch = () => {
    marketsQ.refetch();
    void betsQ.refetch();
    void balanceQ.refetch();
  };

  return { chain, balance, labelsOf, refetch };
}
