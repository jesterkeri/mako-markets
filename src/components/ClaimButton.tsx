'use client';

import { useEffect } from 'react';
import { formatEther } from 'viem';
import {
  useAccount,
  useReadContract,
  useReadContracts,
  useWaitForTransactionReceipt,
} from 'wagmi';
import { makoContract, Outcome, type MarketWithId } from '@/lib/contract';
import { useClaim } from '@/lib/hooks';
import { computeResolvedClaimWei } from '@/lib/bet';

/**
 * Fixed-bottom claim button. Renders only if:
 *   - market is resolved
 *   - connected wallet has a position in the winning side (YES/NO)
 *     OR any position on a REFUND outcome
 *   - user hasn't already claimed
 */
export function ClaimButton({
  market,
  onSuccess,
}: {
  market: MarketWithId;
  onSuccess?: () => void;
}) {
  const { address } = useAccount();

  const { data: userBetData, refetch: refetchUserBet } = useReadContract({
    ...makoContract,
    functionName: 'getUserBet',
    args: address ? [market.id, address] : undefined,
    query: {
      enabled: !!address && market.resolved,
    },
  });
  const { data: feeData } = useReadContracts({
    contracts: [
      { ...makoContract, functionName: 'protocolFeeBps' },
      { ...makoContract, functionName: 'creatorFeeBps' },
    ],
    query: {
      enabled: market.resolved,
    },
  });

  const { claim, hash, isPending, error, reset } = useClaim();
  const { isLoading: isWaiting, isSuccess } = useWaitForTransactionReceipt({ hash });

  useEffect(() => {
    if (!isSuccess) return;
    onSuccess?.();
    refetchUserBet();
    const t = setTimeout(() => reset(), 2500);
    return () => clearTimeout(t);
  }, [isSuccess, onSuccess, refetchUserBet, reset]);

  if (!address || !market.resolved) return null;
  if (!userBetData) return null;

  const [userYes, userNo, hasClaimed] = userBetData as unknown as [bigint, bigint, boolean];
  const feeBps =
    feeData?.[0]?.status === 'success' && feeData?.[1]?.status === 'success'
      ? BigInt(feeData[0].result) + BigInt(feeData[1].result)
      : 300n;

  const outcome = market.outcome;
  let claimableWei = 0n;
  let claimLabel = 'CLAIM';

  if (outcome === Outcome.REFUND) {
    claimableWei = userYes + userNo;
    claimLabel = 'CLAIM REFUND';
  } else if (outcome === Outcome.YES && userYes > 0n) {
    claimableWei = computeResolvedClaimWei(
      market.totalYes,
      market.totalNo,
      userYes,
      feeBps,
    );
    claimLabel = 'CLAIM WINNINGS';
  } else if (outcome === Outcome.NO && userNo > 0n) {
    claimableWei = computeResolvedClaimWei(
      market.totalNo,
      market.totalYes,
      userNo,
      feeBps,
    );
    claimLabel = 'CLAIM WINNINGS';
  }

  if (claimableWei === 0n) return null;

  const handleClaim = async () => {
    try {
      await claim(market.id);
    } catch (e) {
      console.error('[claim] failed:', e);
    }
  };

  const isBusy = isPending || isWaiting;
  const disabled = isBusy || hasClaimed;

  const statusText = hasClaimed
    ? 'ALREADY CLAIMED'
    : isPending
      ? 'CONFIRM IN WALLET…'
      : isWaiting
        ? 'TX LANDING…'
        : isSuccess
          ? 'CLAIMED ✓'
          : error
            ? `ERROR: ${(error as Error).message.slice(0, 100).toUpperCase()}`
            : null;

  return (
    <div className="fixed bottom-9 left-1/2 -translate-x-1/2 w-full max-w-md z-40 px-4">
      <div className="bg-paper border-2 border-ink rounded-2xl shadow-[4px_4px_0_0_#000000] overflow-hidden">
        <div className="px-5 py-3 border-b-2 border-ink bg-surface-elevated flex justify-between items-center">
          <span className="mako-label text-muted">
            {outcome === Outcome.REFUND ? 'REFUND' : 'CLAIMABLE'}
          </span>
          <span className="mako-display text-xl tabular-nums">
            {Number(formatEther(claimableWei)).toFixed(4)} MON
          </span>
        </div>

        <button
          type="button"
          onClick={handleClaim}
          disabled={disabled}
          className={`w-full py-5 mako-display text-lg uppercase tracking-tight transition-all ${
            disabled
              ? 'bg-surface-elevated text-muted cursor-not-allowed'
              : 'bg-signal text-ink hover:bg-signal/90'
          }`}
        >
          {isBusy || hasClaimed ? statusText : claimLabel}
        </button>

        {statusText && !isBusy && !hasClaimed && (
          <div
            className={`px-4 py-2 mako-label text-center border-t-2 border-ink break-words ${
              isSuccess ? 'bg-signal/30 text-ink' : 'bg-mako-red/15 text-mako-red'
            }`}
          >
            {statusText}
          </div>
        )}
      </div>
    </div>
  );
}
