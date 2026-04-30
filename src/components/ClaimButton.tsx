'use client';

import { useEffect } from 'react';
import {
  useAccount,
  useReadContract,
  useWaitForTransactionReceipt,
} from 'wagmi';
import { makoContract, Outcome, type MarketWithId } from '@/lib/contract';
import { useClaim } from '@/lib/hooks';
import { computeResolvedClaim } from '@/lib/bet';
import { formatUsdc } from '@/lib/usdc';

/**
 * Fixed-bottom claim button. Renders only if:
 *   - market is resolved
 *   - connected wallet has a position in the winning side (YES/NO)
 *     OR any position on a REFUND outcome
 *   - user hasn't already claimed
 *
 * **Per-market fee snapshots feed `computeResolvedClaim` SEPARATELY.**
 * Summing protocol+creator up front loses v4's creator-fee-forfeit rule
 * — on a skewed pool the helper drops the creator fee to 0, so the live
 * claim is bigger than a pre-summed `feeBps` would suggest. The v3 path
 * read live globals via `useReadContracts`; that's removed.
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

  const protocolBps = BigInt(market.protocolFeeBpsSnapshot);
  const creatorBps = BigInt(market.creatorFeeBpsSnapshot);

  const outcome = market.outcome;
  let claimableUsdc = 0n;
  let claimLabel = 'CLAIM';

  if (outcome === Outcome.REFUND) {
    claimableUsdc = userYes + userNo;
    claimLabel = 'CLAIM REFUND';
  } else if (outcome === Outcome.YES && userYes > 0n) {
    claimableUsdc = computeResolvedClaim(
      market.totalYes,
      market.totalNo,
      userYes,
      protocolBps,
      creatorBps,
    );
    claimLabel = 'CLAIM WINNINGS';
  } else if (outcome === Outcome.NO && userNo > 0n) {
    claimableUsdc = computeResolvedClaim(
      market.totalNo,
      market.totalYes,
      userNo,
      protocolBps,
      creatorBps,
    );
    claimLabel = 'CLAIM WINNINGS';
  }

  if (claimableUsdc === 0n) return null;

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
      <div className="bg-paper border-2 border-ink rounded-2xl shadow-brutal overflow-hidden">
        <div className="px-5 py-3 border-b-2 border-ink bg-surface-elevated flex justify-between items-center">
          <span className="mako-label text-muted">
            {outcome === Outcome.REFUND ? 'REFUND' : 'CLAIMABLE'}
          </span>
          <span className="mako-display text-xl tabular-nums">
            {formatUsdc(claimableUsdc)} USDC
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
