'use client';

import { useReadContract, useReadContracts, useWriteContract } from 'wagmi';
import { parseEther } from 'viem';
import {
  makoContract,
  type MarketWithId,
  type Market,
  MarketType,
  Outcome,
} from './contract';

// ---------------------------------------------------------------
// Reads
// ---------------------------------------------------------------

/**
 * Read every market from the live contract.
 *
 * Two-step batched read:
 *   1. `nextMarketId()` → total count
 *   2. `useReadContracts` with an array of `getMarket(i)` calls for i in [0, count)
 *
 * Both steps auto-refetch every 5 seconds so the feed stays live as new bets
 * and new markets land on-chain. No manual refetch needed in the UI.
 */
export function useMarkets() {
  const {
    data: nextIdBn,
    isLoading: isCountLoading,
    refetch: refetchCount,
  } = useReadContract({
    ...makoContract,
    functionName: 'nextMarketId',
    query: {
      refetchInterval: 5000,
    },
  });

  const count = nextIdBn !== undefined ? Number(nextIdBn) : 0;

  const {
    data: marketsData,
    isLoading: isMarketsLoading,
    refetch: refetchMarkets,
  } = useReadContracts({
    contracts: Array.from({ length: count }, (_, i) => ({
      ...makoContract,
      functionName: 'getMarket' as const,
      args: [BigInt(i)] as const,
    })),
    query: {
      enabled: count > 0,
      refetchInterval: 5000,
    },
  });

  const markets: MarketWithId[] = (marketsData ?? [])
    .map((result, i): MarketWithId | null => {
      if (result.status !== 'success' || !result.result) return null;
      // wagmi decodes the Market struct into a named-field object because
      // MakoMarkets.abi.ts has `as const` typing. Cast to our Market type.
      const m = result.result as unknown as Market;
      return {
        id: BigInt(i),
        creator: m.creator,
        mType: m.mType as MarketType,
        oracleRef: m.oracleRef,
        question: m.question,
        createdAt: m.createdAt,
        closeTime: m.closeTime,
        totalYes: m.totalYes,
        totalNo: m.totalNo,
        yesBettorCount: Number(m.yesBettorCount),
        noBettorCount: Number(m.noBettorCount),
        outcome: m.outcome as Outcome,
        resolved: m.resolved,
        creatorFeeClaimed: m.creatorFeeClaimed,
      };
    })
    .filter((m): m is MarketWithId => m !== null);

  return {
    markets,
    count,
    isLoading: isCountLoading || (count > 0 && isMarketsLoading),
    refetch: () => {
      refetchCount();
      refetchMarkets();
    },
  };
}

/**
 * Read a single market by id. Used by the detail page.
 */
export function useMarket(id: bigint) {
  const { data, isLoading, refetch } = useReadContract({
    ...makoContract,
    functionName: 'getMarket',
    args: [id],
    query: {
      refetchInterval: 5000,
    },
  });

  const market: MarketWithId | undefined = data
    ? (() => {
        const m = data as unknown as Market;
        return {
          id,
          creator: m.creator,
          mType: m.mType as MarketType,
          oracleRef: m.oracleRef,
          question: m.question,
          createdAt: m.createdAt,
          closeTime: m.closeTime,
          totalYes: m.totalYes,
          totalNo: m.totalNo,
          yesBettorCount: Number(m.yesBettorCount),
          noBettorCount: Number(m.noBettorCount),
          outcome: m.outcome as Outcome,
          resolved: m.resolved,
          creatorFeeClaimed: m.creatorFeeClaimed,
        };
      })()
    : undefined;

  return { market, isLoading, refetch };
}

// ---------------------------------------------------------------
// Writes
// ---------------------------------------------------------------

/**
 * Place a bet on a market. Wraps `useWriteContract` with ergonomic params
 * and converts a human-readable MON amount (e.g. "0.5") via `parseEther`.
 *
 * Usage:
 *   const { placeBet, hash, isPending, error } = usePlaceBet();
 *   await placeBet({ id: 0n, isYes: true, amountMon: '0.1' });
 */
export function usePlaceBet() {
  const { writeContractAsync, data: hash, isPending, error, reset } = useWriteContract();

  const placeBet = async ({
    id,
    isYes,
    amountMon,
  }: {
    id: bigint;
    isYes: boolean;
    amountMon: string;
  }) => {
    return writeContractAsync({
      ...makoContract,
      functionName: 'placeBet',
      args: [id, isYes],
      value: parseEther(amountMon),
    });
  };

  return { placeBet, hash, isPending, error, reset };
}

/**
 * Claim winnings (or refund) for a resolved market.
 */
export function useClaim() {
  const { writeContractAsync, data: hash, isPending, error, reset } = useWriteContract();

  const claim = async (id: bigint) => {
    return writeContractAsync({
      ...makoContract,
      functionName: 'claim',
      args: [id],
    });
  };

  return { claim, hash, isPending, error, reset };
}

/**
 * Create a new market. The caller is responsible for parsing the
 * `MarketCreated` event from the tx receipt to extract the new id —
 * see `useWaitForTransactionReceipt` + `decodeEventLog` in Phase D.
 * Never rely on `nextMarketId() - 1` (race-prone).
 */
export function useCreateMarket() {
  const { writeContractAsync, data: hash, isPending, error, reset } = useWriteContract();

  const create = async ({
    mType,
    oracleRef,
    closeTime,
    question,
  }: {
    mType: MarketType;
    oracleRef: `0x${string}`;
    closeTime: bigint;
    question: string;
  }) => {
    return writeContractAsync({
      ...makoContract,
      functionName: 'createMarket',
      args: [mType, oracleRef, closeTime, question],
    });
  };

  return { create, hash, isPending, error, reset };
}

/**
 * Admin: resolve a closed market with an outcome (YES / NO / REFUND).
 * Gated on-chain by the `onlyResolver` modifier. UI-level admin gate
 * is cosmetic and lives in `src/lib/admin.ts`.
 */
export function useResolveMarket() {
  const { writeContractAsync, data: hash, isPending, error, reset } = useWriteContract();

  const resolve = async ({ id, outcome }: { id: bigint; outcome: Outcome }) => {
    return writeContractAsync({
      ...makoContract,
      functionName: 'resolveMarket',
      args: [id, outcome],
    });
  };

  return { resolve, hash, isPending, error, reset };
}

/**
 * Claim the creator fee on a resolved non-refund market.
 * Only the market's original creator can call this.
 */
export function useClaimCreatorFee() {
  const { writeContractAsync, data: hash, isPending, error, reset } = useWriteContract();

  const claimFee = async (id: bigint) => {
    return writeContractAsync({
      ...makoContract,
      functionName: 'claimCreatorFee',
      args: [id],
    });
  };

  return { claimFee, hash, isPending, error, reset };
}
