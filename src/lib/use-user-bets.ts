'use client';

import { useMemo } from 'react';
import { useReadContracts } from 'wagmi';

import { makoContract } from '@/lib/contract';
import type { UserBet } from '@/lib/pool-list';

/// The account's stake in each of `ids`, read in one multicall and keyed by `id.toString()`. Signed out (null
/// account) reads nothing. A pool whose read failed is simply absent: rows then show no position chip.
export function useUserBets(ids: readonly bigint[], account: `0x${string}` | null): ReadonlyMap<string, UserBet> {
  const { data } = useReadContracts({
    contracts: ids.map((id) => ({ ...makoContract, functionName: 'getUserBet' as const, args: [id, account ?? '0x0000000000000000000000000000000000000000'] as const })),
    query: { enabled: account !== null && ids.length > 0, refetchInterval: 10_000 },
  });
  return useMemo(() => {
    const bets = new Map<string, UserBet>();
    if (!data) return bets;
    data.forEach((r, i) => {
      if (r.status !== 'success' || !r.result) return;
      const [yes, no, claimed] = r.result as readonly [bigint, bigint, boolean];
      bets.set(ids[i].toString(), { yes, no, claimed });
    });
    return bets;
  }, [data, ids]);
}
