'use client';

import { useEffect } from 'react';
import {
  useAccount,
  useReadContract,
  useWaitForTransactionReceipt,
} from 'wagmi';
import { makoContract, Outcome, type MarketWithId } from '@/lib/contract';
import { useClaim } from '@/lib/hooks';
import { useUser } from '@/lib/use-user';
import { computeResolvedClaim } from '@/lib/bet';
import { formatUsdc } from '@/lib/usdc';
import { PersonalOutcomeBanner } from '@/components/PersonalOutcomeBanner';

/**
 * Inline outcome + claim row for /me's CLOSED tab.
 *
 * claim-magic-parity: matches `ClaimButton`'s fix surface but in the
 * compact density used by /me. Magic users see their outcome here for
 * the first time. Losers also see their outcome here for the first
 * time (previous version returned null whenever claimableUsdc === 0n).
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
  const { address: connectedWallet } = useAccount();
  const { user } = useUser();

  // claim-magic-parity #1: resolve betting account from auth state
  // instead of wagmi's useAccount alone. Mirrors /me/page.tsx and
  // ClaimButton.tsx — single shape so a future shared helper is a
  // clean factoring rather than three different inlines.
  const bettingAccount: `0x${string}` | undefined =
    user?.authType === 'magic'
      ? (user.safeAddress as `0x${string}`)
      : connectedWallet;

  const { data: userBetData, refetch: refetchUserBet } = useReadContract({
    ...makoContract,
    functionName: 'getUserBet',
    args: bettingAccount ? [market.id, bettingAccount] : undefined,
    query: {
      enabled: !!bettingAccount && market.resolved,
      refetchInterval: 5000,
    },
  });

  const { claim, hash, isPending, error, reset, phase } = useClaim();
  const { isLoading: isWaiting, isSuccess } = useWaitForTransactionReceipt({
    hash,
  });

  useEffect(() => {
    if (!isSuccess) return;
    onClaimed();
    refetchUserBet();
    const t = setTimeout(() => reset(), 2500);
    return () => clearTimeout(t);
  }, [isSuccess, onClaimed, refetchUserBet, reset]);

  if (!bettingAccount || !market.resolved || !userBetData) return null;

  // wagmi v2 / viem returns tuples with named props attached. Positional
  // access is safe but we handle the object shape defensively too.
  let userYes: bigint;
  let userNo: bigint;
  let hasClaimed: boolean;
  if (Array.isArray(userBetData)) {
    [userYes, userNo, hasClaimed] = userBetData as [bigint, bigint, boolean];
  } else if (typeof userBetData === 'object' && userBetData !== null) {
    const obj = userBetData as {
      yes?: bigint;
      no?: bigint;
      hasClaimed?: boolean;
    };
    userYes = obj.yes ?? 0n;
    userNo = obj.no ?? 0n;
    hasClaimed = obj.hasClaimed ?? false;
  } else {
    return null;
  }

  if (userYes === 0n && userNo === 0n) return null;

  const protocolBps = BigInt(market.protocolFeeBpsSnapshot);
  const creatorBps = BigInt(market.creatorFeeBpsSnapshot);
  const outcome = market.outcome;
  let bannerKind: 'won' | 'lost' | 'refund';
  let bannerAmount: bigint;
  let claimableUsdc = 0n;
  let label = 'CLAIM';

  if (outcome === Outcome.REFUND) {
    bannerKind = 'refund';
    bannerAmount = userYes + userNo;
    claimableUsdc = userYes + userNo;
    label = 'CLAIM REFUND';
  } else if (outcome === Outcome.YES) {
    if (userYes > 0n) {
      bannerKind = 'won';
      claimableUsdc = computeResolvedClaim(
        market.totalYes,
        market.totalNo,
        userYes,
        protocolBps,
        creatorBps,
      );
      bannerAmount = claimableUsdc;
      label = 'CLAIM WINNINGS';
    } else {
      bannerKind = 'lost';
      bannerAmount = userNo;
    }
  } else {
    if (userNo > 0n) {
      bannerKind = 'won';
      claimableUsdc = computeResolvedClaim(
        market.totalNo,
        market.totalYes,
        userNo,
        protocolBps,
        creatorBps,
      );
      bannerAmount = claimableUsdc;
      label = 'CLAIM WINNINGS';
    } else {
      bannerKind = 'lost';
      bannerAmount = userYes;
    }
  }

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
  const showClaimButton = bannerKind !== 'lost' && claimableUsdc > 0n;
  const disabled = isBusy || hasClaimed;

  const statusText = hasClaimed
    ? 'ALREADY CLAIMED'
    : phase === 'awaitingSign'
      ? 'AWAITING SIGNATURE...'
      : phase === 'awaitingWallet'
        ? 'CONFIRM IN WALLET...'
        : phase === 'awaitingClaim' || isWaiting
          ? 'TX LANDING...'
          : phase === 'submitted'
            ? 'SUBMITTED. WE WILL CATCH UP.'
            : isSuccess
              ? 'CLAIMED ✓'
              : error
                ? `ERROR: ${(error as Error).message.slice(0, 80).toUpperCase()}`
                : null;

  return (
    <div className="flex flex-col gap-2">
      <PersonalOutcomeBanner
        kind={bannerKind}
        amountUsdc={bannerAmount}
        hasClaimed={hasClaimed}
        compact
      />
      {showClaimButton && (
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
      )}
    </div>
  );
}
