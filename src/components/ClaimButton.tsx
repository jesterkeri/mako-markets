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
import { PersonalOutcomeBanner } from '@/components/PersonalOutcomeBanner';

/**
 * Resolved-market sidebar for both Magic + wallet users.
 *
 * claim-magic-parity fix (3 bugs at once):
 *   1. **Visibility.** Previous version read `useAccount().address`
 *      (wagmi connected wallet only). Magic users had no wagmi account
 *      and saw NOTHING. Now resolves the betting account the same way
 *      /me/page.tsx and BetSheet do — Magic Safe takes precedence,
 *      wallet falls through to connectedWallet.
 *   2. **Hook dual-path.** `useClaim()` now branches on auth type
 *      internally so the click goes through Magic AA for embedded
 *      Safes and wagmi `writeContractAsync` for connected wallets.
 *   3. **Personal outcome always shown.** Renders
 *      `<PersonalOutcomeBanner>` for WON, LOST, and REFUND — losers
 *      previously saw no per-user state at all.
 *
 * Per-market fee snapshots feed `computeResolvedClaim` SEPARATELY. v4's
 * creator-fee-forfeit rule drops the creator fee to 0 on a skewed pool;
 * summing protocol+creator before the helper computes a smaller payout
 * than the contract pays.
 */
export function ClaimButton({
  market,
  onSuccess,
}: {
  market: MarketWithId;
  onSuccess?: () => void;
}) {
  const { address: connectedWallet } = useAccount();
  const { user } = useUser();

  // claim-magic-parity #1: resolve the betting account the same way
  // /me/page.tsx + BetSheet already do. Magic users have a Safe but
  // no wagmi account; wallet-only users live under connectedWallet.
  // Wallet-session users (no Safe) ALSO fall through to connectedWallet
  // because their bets are owned by the connected wallet.
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
    },
  });

  const { claim, hash, isPending, error, reset, phase } = useClaim();
  // For wallet auth, hash arrives from writeContractAsync BEFORE the
  // receipt lands on-chain. For Magic auth, runClaim polls server-side
  // until status='sent' so the receipt has already landed when hash is
  // set; useWaitForTransactionReceipt resolves isSuccess immediately
  // for an already-mined hash, so the same external wait works for
  // both branches.
  const { isLoading: isWaiting, isSuccess } = useWaitForTransactionReceipt({
    hash,
  });

  useEffect(() => {
    if (!isSuccess) return;
    onSuccess?.();
    refetchUserBet();
    const t = setTimeout(() => reset(), 2500);
    return () => clearTimeout(t);
  }, [isSuccess, onSuccess, refetchUserBet, reset]);

  // Pre-render gates. Render nothing if:
  //   - no betting account (user is fully unauthed — parent shows
  //     SIGN IN CTA instead)
  //   - market hasn't resolved yet
  //   - we don't know the user's position yet (the read is in flight)
  if (!bettingAccount || !market.resolved) return null;
  if (!userBetData) return null;

  const [userYes, userNo, hasClaimed] = userBetData as unknown as [
    bigint,
    bigint,
    boolean,
  ];

  // No position means this user didn't participate. Show nothing
  // (not their market). This is the ONE case where ClaimButton
  // legitimately renders null — losers, winners, and refund-recipients
  // all surface a banner.
  if (userYes === 0n && userNo === 0n) return null;

  const protocolBps = BigInt(market.protocolFeeBpsSnapshot);
  const creatorBps = BigInt(market.creatorFeeBpsSnapshot);
  const outcome = market.outcome;

  // ── Derive personal outcome ─────────────────────────────────────
  let bannerKind: 'won' | 'lost' | 'refund';
  let bannerAmount: bigint;
  let claimableUsdc = 0n;
  let claimLabel = 'CLAIM';

  if (outcome === Outcome.REFUND) {
    bannerKind = 'refund';
    bannerAmount = userYes + userNo;
    claimableUsdc = userYes + userNo;
    claimLabel = 'CLAIM REFUND';
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
      claimLabel = 'CLAIM WINNINGS';
    } else {
      bannerKind = 'lost';
      bannerAmount = userNo;
    }
  } else {
    // Outcome.NO
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
      claimLabel = 'CLAIM WINNINGS';
    } else {
      bannerKind = 'lost';
      bannerAmount = userYes;
    }
  }

  const handleClaim = async () => {
    try {
      await claim(market.id);
    } catch (e) {
      console.error('[claim] failed:', e);
    }
  };

  const isBusy = isPending || isWaiting;
  const showClaimButton = bannerKind !== 'lost' && claimableUsdc > 0n;
  const disabled = isBusy || hasClaimed;

  // Status text for the in-flight states. Magic flow can also reach
  // 'submitted' (bundler accepted, receipt poll timed out) — surface
  // that as a soft info state instead of an error.
  const statusText = hasClaimed
    ? 'ALREADY CLAIMED'
    : phase === 'awaitingSign'
      ? 'AWAITING SIGNATURE...'
      : phase === 'awaitingWallet'
        ? 'CONFIRM IN WALLET...'
        : phase === 'awaitingClaim'
          ? 'TX LANDING...'
          : phase === 'submitted'
            ? 'SUBMITTED. WE WILL CATCH UP.'
            : isWaiting
              ? 'TX LANDING...'
              : isSuccess
                ? 'CLAIMED ✓'
                : error
                  ? `ERROR: ${(error as Error).message.slice(0, 100).toUpperCase()}`
                  : null;

  return (
    <div className="bg-paper border-2 border-ink lg:rounded-[24px] shadow-[0_-12px_40px_rgba(0,0,0,0.12)] lg:shadow-[8px_8px_0_0_var(--mako-ink)] overflow-hidden w-full mx-auto max-w-md lg:max-w-none flex flex-col">
      <div className="px-5 py-5 border-b-2 border-ink bg-surface-elevated">
        <PersonalOutcomeBanner
          kind={bannerKind}
          amountUsdc={bannerAmount}
          hasClaimed={hasClaimed}
        />
      </div>

      {showClaimButton && (
        <div className="p-5 bg-paper">
          <button
            type="button"
            onClick={handleClaim}
            disabled={disabled}
            className={`w-full py-5 mako-display text-xl uppercase tracking-tight transition-all border-2 border-ink rounded-xl shadow-[4px_4px_0_0_var(--mako-ink)] hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-[2px_2px_0_0_var(--mako-ink)] active:translate-x-[4px] active:translate-y-[4px] active:shadow-none ${
              disabled
                ? 'bg-surface-elevated text-muted border-muted/50 shadow-none cursor-not-allowed translate-x-[4px] translate-y-[4px]'
                : 'bg-signal text-ink'
            }`}
          >
            {isBusy || hasClaimed ? statusText : claimLabel}
          </button>

          {statusText && !isBusy && !hasClaimed && (
            <div
              className={`mt-3 px-4 py-2 mako-label text-center border-2 border-ink rounded-xl break-words ${
                isSuccess
                  ? 'bg-signal/30 text-ink'
                  : phase === 'submitted'
                    ? 'bg-surface-elevated text-ink'
                    : 'bg-mako-red/15 text-mako-red'
              }`}
            >
              {statusText}
            </div>
          )}
        </div>
      )}

      {/* For the LOST case (no claim button), surface the human-readable
          tx-fee context once below the banner so the user understands
          where their stake went. Keeps the banner itself tight. */}
      {bannerKind === 'lost' && (
        <div className="px-5 py-3 mako-label text-[10px] text-muted text-center border-t-2 border-ink/10">
          THE WINNING SIDE SPLITS THE TOTAL POOL.
        </div>
      )}
    </div>
  );
}
