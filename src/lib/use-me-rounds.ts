'use client';

// This account's rounds for Me: the rounds the indexer says it entered or created, plus every round the indexer
// cannot vouch for yet, each read on chain with its stake and claims (me-rounds-discovery.ts). The cost per poll is
// 4 reads per round in that set, not per round ever scheduled (Codex ME_ROUNDS R1). All-or-nothing reads (the Me retry
// rule, 2026-10-12): one refused call fails the read so TanStack Query retries it, and a failed refetch keeps the last
// complete data. A failed discovery is an error like a failed chain read: Me never shows pools-only totals for it.
// `off` when Rounds is not configured.

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useReadContract, useReadContracts } from 'wagmi';

import { parseMeRoundsDiscovery, planMeRoundReads, type MeRoundsDiscovery } from './me-rounds-discovery';
import type { RoundStakeRead } from './me-rounds';
import type { Round } from './rounds-model';
import { roundsContract, toRound, type RoundTuple } from './use-rounds';

const POLL_MS = 10_000;
/// The discovery answer changes only when the indexer catches up; every round it has not caught up with is read on
/// chain anyway, so it is asked less often than the chain.
const DISCOVERY_POLL_MS = 30_000;
/// roundOf, stakeOf, stakeClaimed, creatorFeeClaimed.
const PER_ROUND = 4;

export type MeRoundsRead =
  | { status: 'off' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; rounds: Round[]; stakes: Map<string, RoundStakeRead> };

async function fetchDiscovery(account: string): Promise<MeRoundsDiscovery> {
  const res = await fetch(`/api/me/rounds?account=${encodeURIComponent(account)}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`rounds discovery answered ${res.status}`);
  const parsed = parseMeRoundsDiscovery(await res.json());
  if (!parsed) throw new Error('rounds discovery answer not usable');
  return parsed;
}

export function useMeRounds(account: `0x${string}`): MeRoundsRead & { refetch: () => void } {
  const countQ = useReadContract({
    ...(roundsContract ?? {}),
    functionName: 'roundCount',
    query: { enabled: roundsContract !== null, refetchInterval: POLL_MS },
  } as never) as { data?: bigint; isPending: boolean; isError: boolean; refetch: () => void };
  const discoveryQ = useQuery({
    queryKey: ['me-rounds-discovery', account.toLowerCase()],
    queryFn: () => fetchDiscovery(account),
    enabled: roundsContract !== null,
    refetchInterval: DISCOVERY_POLL_MS,
  });
  const count = typeof countQ.data === 'bigint' ? countQ.data : null;
  const discovery = discoveryQ.data;
  const plan = useMemo(() => (count === null || discovery === undefined ? null : planMeRoundReads(count, discovery)), [count, discovery]);
  const ids = useMemo(() => (plan?.ok ? plan.ids : []), [plan]);
  const q = useReadContracts({
    allowFailure: false,
    contracts: roundsContract
      ? ids.flatMap((id) => [
          { ...roundsContract, functionName: 'roundOf', args: [id] } as const,
          { ...roundsContract, functionName: 'stakeOf', args: [id, account] } as const,
          { ...roundsContract, functionName: 'stakeClaimed', args: [id, account] } as const,
          { ...roundsContract, functionName: 'creatorFeeClaimed', args: [id] } as const,
        ])
      : [],
    query: { enabled: roundsContract !== null && ids.length > 0, refetchInterval: POLL_MS },
  });
  const refetch = () => {
    void countQ.refetch();
    void discoveryQ.refetch();
    void q.refetch();
  };

  const data = q.data as readonly unknown[] | undefined;
  const complete = data !== undefined && data.length === ids.length * PER_ROUND;
  const parsed = useMemo(() => {
    if (!complete) return null;
    const rounds: Round[] = [];
    const stakes = new Map<string, RoundStakeRead>();
    ids.forEach((id, i) => {
      const at = i * PER_ROUND;
      rounds.push(toRound(id, data[at] as RoundTuple));
      const s = data[at + 1] as { side: number; amount: bigint };
      const side = Number(s.side) === 1 ? 'up' : Number(s.side) === 2 ? 'down' : null;
      stakes.set(id.toString(), { stake: { side, amount: BigInt(s.amount) }, claimed: Boolean(data[at + 2]), creatorFeeClaimed: Boolean(data[at + 3]) });
    });
    return { rounds, stakes };
  }, [complete, data, ids]);

  if (!roundsContract) return { status: 'off', refetch };
  if (countQ.isError && countQ.data === undefined) return { status: 'error', refetch };
  if (discoveryQ.isError && discoveryQ.data === undefined) return { status: 'error', refetch };
  if (countQ.isPending || discoveryQ.isPending || !plan) return { status: 'loading', refetch };
  // The indexer is too far behind to bound the reads: unavailable, never a partial list.
  if (!plan.ok) return { status: 'error', refetch };
  if (ids.length === 0) return { status: 'ready', rounds: [], stakes: new Map(), refetch };
  if (q.isError && q.data === undefined) return { status: 'error', refetch };
  if (!parsed) return { status: 'loading', refetch };
  return { status: 'ready', ...parsed, refetch };
}
