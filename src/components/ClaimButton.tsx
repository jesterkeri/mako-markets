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
 *
 * Calls `claim(id)` → waits for receipt → refetches market.
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

  // getUserBet returns (uint256 yes, uint256 no, bool hasClaimed)
  const [userYes, userNo, hasClaimed] = userBetData as unknown as [bigint, bigint, boolean];
  const feeBps =
    feeData?.[0]?.status === 'success' && feeData?.[1]?.status === 'success'
      ? BigInt(feeData[0].result) + BigInt(feeData[1].result)
      : 300n;

  // Figure out what the user is entitled to claim.
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

  // No claimable position → render nothing.
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
      ? 'CONFIRM IN WALLET...'
      : isWaiting
        ? 'TX LANDING...'
        : isSuccess
          ? 'CLAIMED ✓'
          : error
            ? `ERROR: ${(error as Error).message.slice(0, 100).toUpperCase()}`
            : null;

  return (
    <div className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-md z-40 bg-background border-t border-black">
      <div className="px-6 py-3 border-b border-black bg-surface text-[11px] font-black uppercase tracking-widest">
        <span className="text-muted">
          {outcome === Outcome.REFUND ? 'REFUND: ' : 'CLAIMABLE: '}
        </span>
        <span className="text-foreground tabular-nums">
          {Number(formatEther(claimableWei)).toFixed(4)} MON
        </span>
      </div>

      <button
        type="button"
        onClick={handleClaim}
        disabled={disabled}
        className={`w-full py-5 font-black uppercase tracking-widest text-base transition-colors ${
          disabled
            ? 'bg-black/20 text-muted cursor-not-allowed'
            : 'bg-black text-background hover:bg-foreground/90'
        }`}
      >
        {isBusy || hasClaimed ? statusText : claimLabel}
      </button>

      {statusText && !isBusy && !hasClaimed && (
        <div
          className={`px-4 py-2 text-[10px] font-black uppercase tracking-widest text-center border-t border-black break-words ${
            isSuccess ? 'bg-yes/15 text-yes' : 'bg-warning/15 text-warning'
          }`}
        >
          {statusText}
        </div>
      )}
    </div>
  );
}
