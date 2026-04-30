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
 *
 * **Per-market fee snapshots feed the claim helper SEPARATELY** — see
 * note in `ClaimButton.tsx` for why summing them is wrong under v4.
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

  const protocolBps = BigInt(market.protocolFeeBpsSnapshot);
  const creatorBps = BigInt(market.creatorFeeBpsSnapshot);
  const outcome = market.outcome;
  let claimableUsdc = 0n;
  let label = 'CLAIM';
  if (outcome === Outcome.REFUND) {
    claimableUsdc = userYes + userNo;
    label = 'CLAIM REFUND';
  } else if (outcome === Outcome.YES && userYes > 0n) {
    claimableUsdc = computeResolvedClaim(
      market.totalYes,
      market.totalNo,
      userYes,
      protocolBps,
      creatorBps,
    );
    label = 'CLAIM WINNINGS';
  } else if (outcome === Outcome.NO && userNo > 0n) {
    claimableUsdc = computeResolvedClaim(
      market.totalNo,
      market.totalYes,
      userNo,
      protocolBps,
      creatorBps,
    );
    label = 'CLAIM WINNINGS';
  }

  if (claimableUsdc === 0n) return null;

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
    <div className="rounded-xl border border-canvas-fg overflow-hidden">
      <button
        type="button"
        onClick={handleClaim}
        disabled={disabled}
        className={`w-full py-2.5 font-black uppercase tracking-widest text-[11px] transition-colors ${
          disabled
            ? 'text-muted cursor-not-allowed'
            : 'text-accent hover:bg-canvas-fg/5'
        }`}
      >
        {isBusy || hasClaimed
          ? statusText
          : `${label} · ${formatUsdc(claimableUsdc)} USDC`}
      </button>
      {statusText && !isBusy && !hasClaimed && (
        <div
          className={`px-4 py-1.5 text-[10px] font-black uppercase tracking-widest text-center border-t border-canvas-divider break-words ${
            isSuccess ? 'text-accent' : 'text-mako-red'
          }`}
        >
          {statusText}
        </div>
      )}
    </div>
  );
}
