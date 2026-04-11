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
 * Inline claim row for /me's CLOSED tab.
 *
 * Reads `getUserBet(id, address)` to find the connected wallet's
 * position in a resolved market, figures out if anything is
 * claimable, and renders a CLAIM button if so. Returns null if
 * the user has no claimable position (they lost, never bet, or
 * already claimed).
 *
 * Click handler uses `e.stopPropagation` so the tap doesn't bubble
 * to the parent <Link> wrapper (which would navigate to the detail
 * page instead of firing the claim).
 */
export function MarketClaimAction({
  market,
  onClaimed,
}: {
  market: MarketWithId;
  onClaimed: () => void;
}) {
  const { address } = useAccount();

  const { data: userBetData, refetch: refetchUserBet } = useReadContract({
    ...makoContract,
    functionName: 'getUserBet',
    args: address ? [market.id, address] : undefined,
    query: {
      enabled: !!address && market.resolved,
      refetchInterval: 5000,
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
    onClaimed();
    refetchUserBet();
    const t = setTimeout(() => reset(), 2500);
    return () => clearTimeout(t);
  }, [isSuccess, onClaimed, refetchUserBet, reset]);

  if (!address || !market.resolved || !userBetData) return null;

  // wagmi v2 / viem returns multi-return tuples with named props attached;
  // positional access is safe but we handle object shape defensively too.
  let userYes: bigint;
  let userNo: bigint;
  let hasClaimed: boolean;
  if (Array.isArray(userBetData)) {
    [userYes, userNo, hasClaimed] = userBetData as [bigint, bigint, boolean];
  } else if (typeof userBetData === 'object' && userBetData !== null) {
    const obj = userBetData as { yes?: bigint; no?: bigint; hasClaimed?: boolean };
    userYes = obj.yes ?? 0n;
    userNo = obj.no ?? 0n;
    hasClaimed = obj.hasClaimed ?? false;
  } else {
    return null;
  }

  // Figure out what's claimable given the resolved outcome.
  const feeBps =
    feeData?.[0]?.status === 'success' && feeData?.[1]?.status === 'success'
      ? BigInt(feeData[0].result) + BigInt(feeData[1].result)
      : 300n;
  const outcome = market.outcome;
  let claimableWei = 0n;
  let label = 'CLAIM';
  if (outcome === Outcome.REFUND) {
    claimableWei = userYes + userNo;
    label = 'CLAIM REFUND';
  } else if (outcome === Outcome.YES && userYes > 0n) {
    claimableWei = computeResolvedClaimWei(
      market.totalYes,
      market.totalNo,
      userYes,
      feeBps,
    );
    label = 'CLAIM WINNINGS';
  } else if (outcome === Outcome.NO && userNo > 0n) {
    claimableWei = computeResolvedClaimWei(
      market.totalNo,
      market.totalYes,
      userNo,
      feeBps,
    );
    label = 'CLAIM WINNINGS';
  }

  // No claimable position → render nothing (user lost, never bet, or
  // already claimed and the refetch hasn't flipped hasClaimed yet).
  if (claimableWei === 0n) return null;

  const handleClaim = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await claim(market.id);
    } catch (err) {
      console.error('[me-claim] failed:', err);
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
            ? `ERROR: ${(error as Error).message.slice(0, 80).toUpperCase()}`
            : null;

  return (
    <div className="border-t border-black bg-yes/5">
      <button
        type="button"
        onClick={handleClaim}
        disabled={disabled}
        className={`w-full py-4 font-black uppercase tracking-widest text-[11px] transition-colors ${
          disabled
            ? 'bg-black/10 text-muted cursor-not-allowed'
            : 'bg-black text-background hover:bg-foreground/90'
        }`}
      >
        {isBusy || hasClaimed
          ? statusText
          : `${label} · ${Number(formatEther(claimableWei)).toFixed(4)} MON`}
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
