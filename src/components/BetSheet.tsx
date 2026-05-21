'use client';

import { useState, useMemo, useEffect } from 'react';
import { useAccount } from 'wagmi';
import { MarketType, type MarketWithId } from '@/lib/contract';
import { usePlaceBet, useUsdcAllowance, useUsdcBalance } from '@/lib/hooks';
import { computePreviewPayout } from '@/lib/bet';
import { parseUsdc, formatUsdc } from '@/lib/usdc';
import { useUser } from '@/lib/use-user';
import { isWalletDrifted } from '@/lib/wallet-drift';
import { WalletDriftBanner } from '@/components/WalletDriftBanner';
import { useMakoLabels } from '@/lib/use-mako-labels';
import { outcomeLabelForMarket } from '@/components/admin-shared';

/**
 * v4 minimum bet — `MakoMarketsV4.MIN_BET` = 100_000 base units (0.10 USDC).
 * Solidity constant; not admin-tunable.
 */
const MIN_BET_USDC_BASE = 100_000n;

/**
 * Fixed-bottom bet sheet for both auth flows.
 *
 * **Magic AA flow (Phase 1D):** one Magic signature, gas sponsored by Mako,
 * approve+placeBet batched into a single user op when allowance is short.
 * The `bettingAccount` exposed by `usePlaceBet` is the user's Safe address.
 * This is what funds the bet — NOT a connected wallet, even if one is
 * present. Balance + allowance lookups MUST run against the Safe so a
 * Magic user with an underfunded connected wallet isn't blocked by a
 * bogus INSUFFICIENT USDC banner.
 *
 * **Wallet 2-tx flow (Phase 1C, unchanged):** user types amount; the hook
 * runs ensure-allowance-then-bet (2 sequential txs: approve once if
 * needed, then placeBet). Simulate-time reverts are decoded into clean
 * error messages.
 *
 * Per-market fee snapshots flow into `computePreviewPayout` SEPARATELY
 * (NOT summed) so the helper can apply v4's creator-fee-forfeit rule on
 * skewed pools.
 *
 * **Approval policy:** infinite (`MaxUint256`) for both flows — matches
 * the existing wagmi behavior. Trade-off: if MakoMarketsV4 is compromised,
 * the approval lets it drain the user's USDC (from the connected wallet
 * for the wallet flow, from the Safe for the Magic flow). Audited
 * contract is the mitigation; first-approval copy below the button warns
 * the Magic user explicitly.
 */
export function BetSheet({
  market,
  side,
  onSuccess,
}: {
  market: MarketWithId;
  side: 'yes' | 'no';
  onSuccess?: () => void;
}) {
  /// MAKO outcome labels — null for non-MAKO markets (hook stays
  /// disabled, no fetch fires). The render path uses
  /// `outcomeLabelForMarket` which delegates to the pure
  /// `outcomeLabel` when labels are null, so the wagmi-flow YES/NO
  /// stays byte-identical for the six public market types.
  const { data: makoLabels } = useMakoLabels(
    market.mType === MarketType.MAKO ? market.id.toString() : null,
  );
  const sideOutcome: 0 | 1 | 2 | 3 = side === 'yes' ? 1 : 2;
  const sideLabel = outcomeLabelForMarket(market, makoLabels ?? null, sideOutcome);

  const [amount, setAmount] = useState('1');
  // Collapsed state. When true the sheet shrinks to just the header bar
  // (BET YES/NO + balance pill + chevron) so the user can read the
  // market detail underneath without dismissing the bet flow entirely.
  // Mobile-first feature — on lg+ the sheet sits in the right column
  // and there's no overlap to clear, but the toggle still works.
  const [collapsed, setCollapsed] = useState(false);

  const betUsdc = useMemo(() => {
    try {
      return parseUsdc(amount || '0');
    } catch {
      return 0n;
    }
  }, [amount]);

  const payoutUsdc = useMemo(
    () =>
      computePreviewPayout(
        market.totalYes,
        market.totalNo,
        betUsdc,
        side === 'yes',
        BigInt(market.protocolFeeBpsSnapshot),
        BigInt(market.creatorFeeBpsSnapshot),
      ),
    [
      market.totalYes,
      market.totalNo,
      market.protocolFeeBpsSnapshot,
      market.creatorFeeBpsSnapshot,
      betUsdc,
      side,
    ],
  );

  const profitUsdc = payoutUsdc > betUsdc ? payoutUsdc - betUsdc : 0n;
  // v4's `previewPayout` returns the full stake (1× refund preview) when
  // loserPool == 0 — the empty-side market settles via REFUND outcome.
  // Detect the empty-side branch DIRECTLY from pool composition, not via
  // `payoutUsdc === betUsdc` — there are non-empty pool shapes where
  // exact rounding produces payout == stake (e.g. 96/3 with a 1 USDC bet
  // at 3% fee), and that's not a refund preview.
  const wouldRefund =
    betUsdc > 0n && (side === 'yes' ? market.totalNo === 0n : market.totalYes === 0n);

  const {
    placeBet,
    phase,
    betHash,
    error,
    reset,
    flow,
    bettingAccount,
  } = usePlaceBet();

  // Wallet-session drift gate (plan step 22). Hook stays drift-unaware
  // — this is enforced at the call-site so admin / dev surfaces that
  // bypass the cookie can still place bets via their connected wallet.
  // For wallet-authed users on /market/[id], a drift between the cookie
  // wallet and the connected wallet means edits would land on identity
  // A while bets would sign with B; we disable the button + render an
  // inline banner with the resolution choice.
  const { user } = useUser();
  const { address: connectedWallet } = useAccount();
  const drifted = isWalletDrifted(user ?? null, connectedWallet);

  // Balance + allowance run against `bettingAccount` — the address that
  // ACTUALLY funds the bet. For Magic users that's the Safe; for wallet
  // users it's `walletAddress`. Group 5 round-1 MAJOR 1 fix.
  const { data: balance, refetch: refetchBalance } =
    useUsdcBalance(bettingAccount);
  const { data: allowance, refetch: refetchAllowance } =
    useUsdcAllowance(bettingAccount);

  // Refetch allowance the moment the hook leaves the approval phases
  // (regardless of whether the bet later succeeds or fails). Without
  // this, an approve-then-bet-revert leaves the BetSheet showing
  // "APPROVE USDC" until the 5s polling interval catches up, even
  // though the allowance is already live on-chain.
  useEffect(() => {
    if (phase === 'betting' || phase === 'success' || phase === 'error') {
      refetchAllowance();
    }
  }, [phase, refetchAllowance]);

  useEffect(() => {
    if (phase !== 'success') return;
    onSuccess?.();
    refetchBalance();
    refetchAllowance();
    const t = setTimeout(() => reset(), 2500);
    return () => clearTimeout(t);
  }, [phase, onSuccess, refetchBalance, refetchAllowance, reset]);

  const balanceBn = (balance as bigint | undefined) ?? 0n;
  const allowanceBn = (allowance as bigint | undefined) ?? 0n;

  type Validation =
    | { ok: true; reason?: undefined }
    | { ok: false; reason: 'enter' | 'min' | 'balance' };

  const validation: Validation = useMemo<Validation>(() => {
    if (betUsdc === 0n) return { ok: false, reason: 'enter' };
    if (betUsdc < MIN_BET_USDC_BASE) return { ok: false, reason: 'min' };
    if (bettingAccount && betUsdc > balanceBn) return { ok: false, reason: 'balance' };
    return { ok: true };
  }, [betUsdc, balanceBn, bettingAccount]);

  const needsApprove = bettingAccount ? allowanceBn < betUsdc : true;

  const handlePlaceBet = async () => {
    if (!validation.ok) return;
    // Drift gate at the call-site (codex round-11 MINOR fix). Mirrors
    // the per-tab guard in /create — the visible button's `disabled`
    // already gates this, but a stale-submit path (programmatic click,
    // enter-key on a stale field) could otherwise reach `placeBet()`
    // while the connected wallet has drifted from the session wallet.
    if (drifted) return;
    await placeBet({
      id: market.id,
      isYes: side === 'yes',
      amountUsdc: amount,
    });
  };

  const isBusy =
    phase === 'preparing' ||
    phase === 'approving' ||
    phase === 'awaitingApprove' ||
    phase === 'betting' ||
    phase === 'awaitingBet';
  // Treat the auth-loading window as busy too — `flow === 'loading'`
  // means useUser hasn't resolved yet; clicking would fall through to
  // the wallet branch and surface a confusing "Connect a wallet…" error
  // even if the user's Magic session is about to load. Round-1 MINOR 2
  // fix from Group 5 review.
  const authLoading = flow === 'loading';
  // Also disable while showing the post-success "BET PLACED ✓" badge so a
  // click during the 2.5s success window can't fire a second placeBet
  // before reset() flips us back to idle.
  const disabled =
    isBusy || authLoading || phase === 'success' || !validation.ok || drifted;

  const buttonLabel = (() => {
    if (authLoading) return 'CHECKING AUTH…';
    // Magic flow: single-signature, no separate approve step. Phase 1D
    // copy table — see plan v4 §"BetSheet edit section" for the full
    // RunOutcome → copy mapping. The hook collapses sponsor/sign/send
    // into the existing phase machine: preparing → betting → awaitingBet.
    if (flow === 'magic') {
      if (phase === 'preparing') return 'PREPARING…';
      if (phase === 'betting') return 'AWAITING SIGNATURE…';
      if (phase === 'awaitingBet') return 'CONFIRMING ON CHAIN…';
      if (phase === 'success') return 'BET PLACED ✓';
      if (phase === 'submitted') return 'BET SUBMITTED';
      if (validation.reason === 'min') return 'MIN BET 0.1 USDC';
      if (validation.reason === 'balance') return 'INSUFFICIENT USDC';
      return `CONFIRM BET · ${amount || '0'} USDC ${sideLabel}`;
    }
    // Wallet flow (existing 2-tx path, unchanged):
    if (phase === 'preparing') return 'PREPARING…';
    if (phase === 'approving') return 'APPROVE IN WALLET…';
    if (phase === 'awaitingApprove') return 'APPROVE TX LANDING…';
    if (phase === 'betting') return 'CONFIRM IN WALLET…';
    if (phase === 'awaitingBet') return 'TX LANDING…';
    if (phase === 'success') return 'BET PLACED ✓';
    if (validation.reason === 'min') return 'MIN BET 0.1 USDC';
    if (validation.reason === 'balance') return 'INSUFFICIENT USDC';
    if (needsApprove) return `APPROVE USDC · ${amount || '0'} ${sideLabel}`;
    return `PLACE BET · ${amount || '0'} USDC ${sideLabel}`;
  })();

  const successText = phase === 'success' ? 'BET PLACED ✓' : null;
  const errorText = phase === 'error' && error
    ? error.message.slice(0, 140).toUpperCase()
    : null;
  // Submitted = non-blocking info (round-1 MAJOR 2 fix from Group 5
  // review). Bundler accepted; receipt poll didn't confirm in 90s. The
  // cron resolver settles within ~5min via on-chain truth. User can
  // dismiss via the Reset button, or just wait + check /me later.
  const submittedText =
    phase === 'submitted'
      ? 'BET SUBMITTED · CONFIRMING ON CHAIN — MAY TAKE UP TO 5 MIN. CHECK /me TO SEE IF IT LANDED.'
      : null;
  const statusText = isBusy
    ? buttonLabel
    : successText ?? errorText ?? submittedText;

  return (
    <div className="w-full bg-paper border-t-2 lg:border-2 border-ink lg:shadow-[8px_8px_0_0_var(--mako-shadow)] lg:rounded-none flex flex-col relative overflow-hidden transition-all duration-300 lg:rotate-2 lg:scale-95 transform-gpu origin-center pb-safe lg:pb-0">
      {/* Top thin accent line indicating side */}
      <div className={`h-2 w-full transition-colors ${side === 'yes' ? 'bg-signal' : 'bg-mako-red'}`} />
      
      <div className={`p-4 md:p-6 flex flex-col ${collapsed ? 'pb-4 lg:pb-6' : ''}`}>
        {/* Header */}
        <div className={`flex flex-wrap items-start justify-between gap-y-3 gap-x-2 ${collapsed ? '' : 'mb-4 md:mb-8'}`}>
          <div className="flex items-center gap-2 md:gap-3 shrink-0">
            <button
              type="button"
              onClick={() => setCollapsed((c) => !c)}
              aria-label={collapsed ? 'Expand bet sheet' : 'Collapse bet sheet'}
              aria-expanded={!collapsed}
              className="shrink-0 w-8 h-8 lg:hidden flex items-center justify-center border-2 border-ink rounded-md hover:bg-ink hover:text-paper transition-colors"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={`w-4 h-4 transition-transform ${collapsed ? '' : 'rotate-180'}`}
                aria-hidden="true"
              >
                <polyline points="6 15 12 9 18 15" />
              </svg>
            </button>
            <h2 className="mako-display text-[clamp(1.5rem,3vw,2.25rem)] tracking-tight leading-none truncate">
              BET {sideLabel}
              {collapsed && betUsdc > 0n && (
                <span className="mako-mono text-sm sm:text-base text-muted ml-2 align-middle lg:hidden">
                  · {amount} USDC
                </span>
              )}
            </h2>
          </div>
          {bettingAccount && (
            <div className="text-right">
              <div className="mako-label text-muted text-[8px] sm:text-[9px] mb-1">AVAILABLE BALANCE</div>
              <div className="mako-mono text-ink text-[10px] sm:text-xs bg-surface-elevated px-2 py-1 border-2 border-ink/10 inline-block">{formatUsdc(balanceBn)} USDC</div>
            </div>
          )}
        </div>

        {/* Body — hidden when the user has tapped the chevron to
            collapse the sheet. The header above stays visible so the
            user retains context of what they were betting and a one-tap
            way to re-expand. The collapse mechanic is mobile-only — at
            lg+ the sheet sits in the right column with no overlap, so
            the body is always shown regardless of `collapsed` state.
            This also handles the resize-while-collapsed edge case where
            a user collapses on mobile then enlarges to desktop. */}
        <div className={collapsed ? 'hidden lg:flex lg:flex-col' : 'flex flex-col'}>
        {/* Amount Input */}
        <div className="mb-4 md:mb-8">
          <div className="flex items-end justify-between border-b-2 md:border-b-4 border-ink py-1 md:py-2 relative group">
            <span className="mako-display text-xl md:text-2xl text-ink/20 absolute left-0 bottom-2 md:bottom-4 pointer-events-none transition-colors group-focus-within:text-ink/60">$</span>
            <input
              id="bet-amount"
              type="text"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
              disabled={isBusy}
              className="w-full bg-transparent border-0 outline-none mako-display text-[clamp(2.25rem,5vw,3.75rem)] tracking-tighter text-right pl-6 md:pl-8 pr-2 placeholder-ink/10 text-ink"
              placeholder="0"
            />
          </div>
          <div className="flex justify-between items-center mt-2 md:mt-3">
             <span className="mako-label text-muted text-[9px] sm:text-[10px]">STAKE AMOUNT</span>
             <span className="mako-label text-ink bg-ink text-paper px-2 py-0.5 text-[9px] sm:text-[10px]">USDC</span>
          </div>
        </div>

        {/* Payout Details */}
        <div className="bg-surface-elevated border-2 border-ink/20 p-3 md:p-4 mb-4 md:mb-8 flex flex-col gap-2 md:gap-3 relative">
          <div className="absolute inset-0 pointer-events-none opacity-[0.03]" style={{ backgroundImage: 'radial-gradient(var(--mako-ink) 2px, transparent 2px)', backgroundSize: '16px 16px' }} />
          
          {betUsdc === 0n ? (
            <div className="text-center text-muted mako-label py-2 md:py-4 text-xs md:text-sm">ENTER AMOUNT TO CALCULATE</div>
          ) : wouldRefund ? (
            <div className="text-center text-mako-red mako-label py-2 md:py-4 text-xs md:text-sm">ONE-SIDED POOL · REFUND AT RESOLVE</div>
          ) : (
            <>
              <div className="flex justify-between items-end border-b-2 border-ink/10 pb-1 md:pb-2">
                <span className="mako-label text-muted text-[9px] sm:text-[10px]">ESTIMATED PAYOUT</span>
                <span className="mako-display text-xl sm:text-2xl tabular-nums">{formatUsdc(payoutUsdc)}</span>
              </div>
              <div className="flex justify-between items-end pt-1">
                <span className="mako-label text-muted text-[9px] sm:text-[10px]">POTENTIAL PROFIT</span>
                <span className="mako-display text-lg sm:text-xl tabular-nums text-ink">+{formatUsdc(profitUsdc)}</span>
              </div>
            </>
          )}
        </div>

        {/* Wallet-drift banner (plan step 22). Inline above the Place
            Bet button so the user sees the resolution choice the moment
            they look at the action surface. */}
        {drifted && user?.authType === 'wallet' && connectedWallet && (
          <div className="mb-4">
            <WalletDriftBanner
              sessionWallet={user.walletAddress}
              connectedWallet={connectedWallet}
            />
          </div>
        )}

        {/* Submit */}
        <div className="relative">
          <button
            type="button"
            onClick={handlePlaceBet}
            disabled={disabled}
            className={`w-full py-3 md:py-4 mako-display text-lg md:text-xl uppercase tracking-tight transition-all border-2 border-ink shadow-[4px_4px_0_0_var(--mako-ink)] hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-[2px_2px_0_0_var(--mako-ink)] active:translate-x-[4px] active:translate-y-[4px] active:shadow-none ${
              disabled
                ? 'bg-surface-elevated text-muted border-muted/50 shadow-none cursor-not-allowed translate-x-[4px] translate-y-[4px]'
                : 'bg-ink text-paper hover:bg-ink/90'
            }`}
          >
            {buttonLabel}
          </button>
        </div>

        {/* Status Messages */}
        <div className="mt-4 flex flex-col gap-2">
          {/* First-approval copy */}
          {flow === 'magic' && betUsdc > 0n && allowanceBn < betUsdc && phase === 'idle' && (
            <div className="mako-label text-[11px] text-muted text-center leading-relaxed">
              FIRST-TIME APPROVAL: GRANTS UNLIMITED USDC SPEND TO MAKO<br/>GAS COVERED BY MAKO
            </div>
          )}
          {flow === 'magic' && (allowanceBn >= betUsdc || betUsdc === 0n) && phase === 'idle' && (
            <div className="mako-label text-[11px] text-muted text-center">
              GAS COVERED BY MAKO
            </div>
          )}

          {/* Non-busy status */}
          {statusText && !isBusy && (
            <div
              className={`px-5 py-4 mako-label text-center border-2 border-ink break-words ${
                phase === 'success'
                  ? 'bg-signal text-ink'
                  : phase === 'submitted'
                    ? 'bg-surface-elevated text-muted'
                    : 'bg-mako-red text-paper'
              }`}
            >
              {statusText}
            </div>
          )}

          {/* Dismiss button */}
          {phase === 'submitted' && (
            <button
              type="button"
              onClick={reset}
              className="w-full px-5 py-4 mako-label text-sm text-center border-2 border-ink bg-paper hover:bg-surface-elevated transition-colors"
            >
              DISMISS
            </button>
          )}

          {/* Tx hash chips */}
          {betHash && phase === 'awaitingBet' && (
            <div className="px-4 mako-label text-[10px] text-muted text-center break-all">
              {betHash}
            </div>
          )}
        </div>
        </div>
      </div>
    </div>
  );
}
