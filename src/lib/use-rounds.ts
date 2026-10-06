'use client';

import { useMemo } from 'react';
import { useReadContract, useReadContracts } from 'wagmi';

import { monadTestnet } from './chain';
import { ROUNDS_ADDRESS } from './contract';
import { roundsAbi } from './rounds-abi';
import type { Round, RoundSide, Stake } from './rounds-model';

// Rounds read straight from MakoRoundsV1 on Monad. Several reads go out as one Multicall3 call (the chain config
// names it), so a page costs one JSON-RPC item, inside the public RPC's 15-items-a-second limit.

const POLL_MS = 10_000;
/// How many of the newest rounds the list reads. Rounds run on a schedule of a few a day, so this covers the
/// upcoming, live and recent ones.
export const ROUNDS_WINDOW = 16;

export const roundsContract = ROUNDS_ADDRESS ? ({ address: ROUNDS_ADDRESS, abi: roundsAbi, chainId: monadTestnet.id } as const) : null;

type RoundTuple = {
  creator: `0x${string}`;
  openTime: bigint;
  startTime: bigint;
  status: number;
  outcome: number;
  refundReason: number;
  anchorPrice: bigint;
  closePrice: bigint;
  upPool: bigint;
  downPool: bigint;
  upEntrants: number;
  downEntrants: number;
  protocolFee: bigint;
  creatorFee: bigint;
  distributable: bigint;
};

export function toRound(id: bigint, t: RoundTuple): Round {
  return {
    id,
    creator: t.creator,
    openTime: Number(t.openTime),
    startTime: Number(t.startTime),
    status: Number(t.status),
    outcome: Number(t.outcome),
    refundReason: Number(t.refundReason),
    anchorPrice: BigInt(t.anchorPrice),
    closePrice: BigInt(t.closePrice),
    upPool: BigInt(t.upPool),
    downPool: BigInt(t.downPool),
    upEntrants: Number(t.upEntrants),
    downEntrants: Number(t.downEntrants),
    protocolFee: BigInt(t.protocolFee),
    creatorFee: BigInt(t.creatorFee),
    distributable: BigInt(t.distributable),
  };
}

export type RoundsState =
  | { kind: 'off' }
  | { kind: 'loading' }
  | { kind: 'error'; retry: () => void }
  | { kind: 'ready'; rounds: Round[]; refetch: () => void };

/// The newest rounds, newest first. `off` when Rounds is not deployed or not configured.
export function useRounds(): RoundsState {
  const countQ = useReadContract({
    ...(roundsContract ?? {}),
    functionName: 'roundCount',
    query: { enabled: roundsContract !== null, refetchInterval: POLL_MS },
  } as never) as { data?: bigint; isError: boolean; refetch: () => void };
  const count = typeof countQ.data === 'bigint' ? countQ.data : null;
  const ids = useMemo(() => {
    if (count === null) return [];
    const out: bigint[] = [];
    for (let id = count; id >= 1n && out.length < ROUNDS_WINDOW; id--) out.push(id);
    return out;
  }, [count]);
  const roundsQ = useReadContracts({
    contracts: ids.map((id) => ({ ...roundsContract!, functionName: 'roundOf', args: [id] }) as const),
    query: { enabled: roundsContract !== null && ids.length > 0, refetchInterval: POLL_MS },
  });

  if (!roundsContract) return { kind: 'off' };
  if (countQ.isError || roundsQ.isError) {
    return {
      kind: 'error',
      retry: () => {
        void countQ.refetch();
        void roundsQ.refetch();
      },
    };
  }
  if (count === null) return { kind: 'loading' };
  if (ids.length === 0) return { kind: 'ready', rounds: [], refetch: () => void countQ.refetch() };
  if (!roundsQ.data) return { kind: 'loading' };
  // A failed read of any one round is an error for the page, never a round silently missing from it.
  if (roundsQ.data.some((r) => r.status !== 'success')) return { kind: 'error', retry: () => void roundsQ.refetch() };
  const rounds = roundsQ.data.map((r, i) => toRound(ids[i], r.result as unknown as RoundTuple));
  return {
    kind: 'ready',
    rounds,
    refetch: () => {
      void countQ.refetch();
      void roundsQ.refetch();
    },
  };
}

export type RoundState =
  | { kind: 'off' }
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'error'; retry: () => void }
  | { kind: 'ready'; round: Round; refetch: () => void };

/// One round. `missing` when the id was never scheduled (the contract reverts for an unknown id).
export function useRound(id: bigint): RoundState {
  const countQ = useReadContract({
    ...(roundsContract ?? {}),
    functionName: 'roundCount',
    query: { enabled: roundsContract !== null, refetchInterval: POLL_MS },
  } as never) as { data?: bigint; isError: boolean; refetch: () => void };
  const exists = typeof countQ.data === 'bigint' ? id >= 1n && id <= countQ.data : null;
  const roundQ = useReadContract({
    ...(roundsContract ?? {}),
    functionName: 'roundOf',
    args: [id],
    query: { enabled: roundsContract !== null && exists === true, refetchInterval: POLL_MS },
  } as never) as { data?: RoundTuple; isError: boolean; refetch: () => void };

  if (!roundsContract) return { kind: 'off' };
  if (countQ.isError || roundQ.isError) {
    return {
      kind: 'error',
      retry: () => {
        void countQ.refetch();
        void roundQ.refetch();
      },
    };
  }
  if (exists === null) return { kind: 'loading' };
  if (!exists) return { kind: 'missing' };
  if (!roundQ.data) return { kind: 'loading' };
  return { kind: 'ready', round: toRound(id, roundQ.data), refetch: () => void roundQ.refetch() };
}

/// The account's stake in a round and whether it was claimed. `null` while unknown or signed out.
export function useRoundStake(id: bigint, account: `0x${string}` | null): { stake: Stake; claimed: boolean; refetch: () => void } | null {
  const q = useReadContracts({
    contracts: account
      ? ([
          { ...roundsContract!, functionName: 'stakeOf', args: [id, account] },
          { ...roundsContract!, functionName: 'stakeClaimed', args: [id, account] },
        ] as const)
      : [],
    query: { enabled: roundsContract !== null && account !== null, refetchInterval: POLL_MS },
  });
  const [stakeR, claimedR] = q.data ?? [];
  if (!account || !stakeR || !claimedR || stakeR.status !== 'success' || claimedR.status !== 'success') return null;
  const s = stakeR.result as unknown as { side: number; amount: bigint };
  const side: RoundSide | null = Number(s.side) === 1 ? 'up' : Number(s.side) === 2 ? 'down' : null;
  return { stake: { side, amount: BigInt(s.amount) }, claimed: Boolean(claimedR.result), refetch: () => void q.refetch() };
}

/// Whether `account` may schedule rounds, and the creator fee state for a round it created.
export function useIsCreator(account: `0x${string}` | null): boolean | null {
  const q = useReadContract({
    ...(roundsContract ?? {}),
    functionName: 'isCreator',
    args: [account ?? '0x0000000000000000000000000000000000000000'],
    query: { enabled: roundsContract !== null && account !== null },
  } as never) as { data?: boolean };
  if (!account || typeof q.data !== 'boolean') return null;
  return q.data;
}

export function useCreatorFeeClaimed(id: bigint, enabled: boolean): boolean | null {
  const q = useReadContract({
    ...(roundsContract ?? {}),
    functionName: 'creatorFeeClaimed',
    args: [id],
    query: { enabled: roundsContract !== null && enabled, refetchInterval: POLL_MS },
  } as never) as { data?: boolean };
  return typeof q.data === 'boolean' ? q.data : null;
}
