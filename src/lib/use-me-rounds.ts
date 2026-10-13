'use client';

// Every round, and this account's stake and claim in each, for Me. All-or-nothing reads (the Me retry rule,
// 2026-10-12): one refused call fails the read so TanStack Query retries it, and a failed refetch keeps the last
// complete data. `off` when Rounds is not configured.

import { useMemo } from 'react';
import { useReadContract, useReadContracts } from 'wagmi';

import type { RoundStakeRead } from './me-rounds';
import type { Round } from './rounds-model';
import { roundsContract, toRound, type RoundTuple } from './use-rounds';

const POLL_MS = 10_000;

export type MeRoundsRead =
  | { status: 'off' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; rounds: Round[]; stakes: Map<string, RoundStakeRead> };

export function useMeRounds(account: `0x${string}`): MeRoundsRead & { refetch: () => void } {
  const countQ = useReadContract({
    ...(roundsContract ?? {}),
    functionName: 'roundCount',
    query: { enabled: roundsContract !== null, refetchInterval: POLL_MS },
  } as never) as { data?: bigint; isPending: boolean; isError: boolean; refetch: () => void };
  const count = typeof countQ.data === 'bigint' ? Number(countQ.data) : null;
  const ids = useMemo(() => (count === null ? [] : Array.from({ length: count }, (_, i) => BigInt(i + 1))), [count]);
  const q = useReadContracts({
    allowFailure: false,
    contracts: roundsContract
      ? ids.flatMap((id) => [
          { ...roundsContract, functionName: 'roundOf', args: [id] } as const,
          { ...roundsContract, functionName: 'stakeOf', args: [id, account] } as const,
          { ...roundsContract, functionName: 'stakeClaimed', args: [id, account] } as const,
        ])
      : [],
    query: { enabled: roundsContract !== null && ids.length > 0, refetchInterval: POLL_MS },
  });
  const refetch = () => {
    void countQ.refetch();
    void q.refetch();
  };

  const data = q.data as readonly unknown[] | undefined;
  const complete = data !== undefined && data.length === ids.length * 3;
  const parsed = useMemo(() => {
    if (!complete) return null;
    const rounds: Round[] = [];
    const stakes = new Map<string, RoundStakeRead>();
    ids.forEach((id, i) => {
      rounds.push(toRound(id, data[i * 3] as RoundTuple));
      const s = data[i * 3 + 1] as { side: number; amount: bigint };
      const side = Number(s.side) === 1 ? 'up' : Number(s.side) === 2 ? 'down' : null;
      stakes.set(id.toString(), { stake: { side, amount: BigInt(s.amount) }, claimed: Boolean(data[i * 3 + 2]) });
    });
    return { rounds, stakes };
  }, [complete, data, ids]);

  if (!roundsContract) return { status: 'off', refetch };
  if (countQ.isError && countQ.data === undefined) return { status: 'error', refetch };
  if (countQ.isPending) return { status: 'loading', refetch };
  if (ids.length === 0) return { status: 'ready', rounds: [], stakes: new Map(), refetch };
  if (q.isError && q.data === undefined) return { status: 'error', refetch };
  if (!parsed) return { status: 'loading', refetch };
  return { status: 'ready', ...parsed, refetch };
}
