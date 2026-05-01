'use client';

import { useState, useMemo, useEffect } from 'react';
import { type MarketWithId } from '@/lib/contract';
import { usePlaceBet, useUsdcAllowance, useUsdcBalance } from '@/lib/hooks';
import { computePreviewPayout } from '@/lib/bet';
import { parseUsdc, formatUsdc } from '@/lib/usdc';

/**
 * v4 minimum bet — `MakoMarketsV4.MIN_BET` = 1_000_000 base units (1 USDC).
 * Solidity constant; not admin-tunable.
 */
const MIN_BET_USDC_BASE = 1_000_000n;

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
  const [amount, setAmount] = useState('1');

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
    isBusy || authLoading || phase === 'success' || !validation.ok;

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
      if (validation.reason === 'min') return 'MIN BET 1 USDC';
      if (validation.reason === 'balance') return 'INSUFFICIENT USDC';
      return `CONFIRM BET · ${amount || '0'} USDC ${side.toUpperCase()}`;
    }
    // Wallet flow (existing 2-tx path, unchanged):
    if (phase === 'preparing') return 'PREPARING…';
    if (phase === 'approving') return 'APPROVE IN WALLET…';
    if (phase === 'awaitingApprove') return 'APPROVE TX LANDING…';
    if (phase === 'betting') return 'CONFIRM IN WALLET…';
    if (phase === 'awaitingBet') return 'TX LANDING…';
    if (phase === 'success') return 'BET PLACED ✓';
    if (validation.reason === 'min') return 'MIN BET 1 USDC';
    if (validation.reason === 'balance') return 'INSUFFICIENT USDC';
    if (needsApprove) return `APPROVE USDC · ${amount || '0'} ${side.toUpperCase()}`;
    return `PLACE BET · ${amount || '0'} USDC ${side.toUpperCase()}`;
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
    <div className="fixed bottom-9 left-1/2 -translate-x-1/2 w-full max-w-md z-40 px-4">
      <div className="bg-paper border-2 border-ink rounded-2xl shadow-brutal overflow-hidden">
        {/* Balance pill — shows whenever a betting account exists, which
            is true for both Magic users (Safe address) and wallet users
            (connected wallet address). */}
        {bettingAccount && (
          <div className="px-5 py-2 border-b-2 border-ink bg-paper flex items-center justify-between">
            <span className="mako-label text-muted">BAL</span>
            <span className="mako-display text-sm tabular-nums">
              {formatUsdc(balanceBn)} USDC
            </span>
          </div>
        )}

        {/* Amount input */}
        <div className="px-5 py-3 border-b-2 border-ink flex items-center gap-3 bg-surface-elevated">
          <label htmlFor="bet-amount" className="mako-label text-muted">
            AMOUNT
          </label>
          <input
            id="bet-amount"
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
            disabled={isBusy}
            className="flex-1 min-w-0 bg-transparent border-0 outline-none mako-display text-3xl tabular-nums disabled:opacity-50"
            placeholder="0"
          />
          <span className="mako-label text-muted">USDC</span>
        </div>

        {/* Payout preview */}
        <div className="px-5 py-3 border-b-2 border-ink bg-paper mako-label leading-relaxed">
          {betUsdc === 0n ? (
            <span className="text-muted">ENTER AMOUNT TO PREVIEW PAYOUT</span>
          ) : wouldRefund ? (
            <span className="text-mako-red">POOL ONE-SIDED · STAKE REFUNDED AT RESOLVE (1×)</span>
          ) : (
            <div className="flex justify-between gap-4">
              <div className="text-muted">
                WIN{' '}
                <span className="text-ink tabular-nums ml-1">
                  {formatUsdc(payoutUsdc)}
                </span>
              </div>
              <div className="text-muted">
                PROFIT{' '}
                <span className="text-ink tabular-nums ml-1">
                  +{formatUsdc(profitUsdc)}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Place Bet button */}
        <button
          type="button"
          onClick={handlePlaceBet}
          disabled={disabled}
          className={`w-full py-4 mako-display text-lg uppercase tracking-tight transition-all ${
            disabled
              ? 'bg-surface-elevated text-muted cursor-not-allowed'
              : side === 'yes'
                ? 'bg-ink text-paper hover:bg-ink/90'
                : 'bg-mako-red text-paper hover:bg-mako-red/90'
          }`}
        >
          {buttonLabel}
        </button>

        {/* First-approval copy (Magic users only, allowance < amount).
            Phase 1D plan v4 round-2 MINOR 2 fix — broadened condition
            from `allowance == 0` to `allowance < amount` since the
            batched MaxUint256 approval grants unlimited spend in either
            case. Also serves as the "gas covered by Mako" note. */}
        {flow === 'magic' && betUsdc > 0n && allowanceBn < betUsdc && phase === 'idle' && (
          <div className="px-4 py-2 mako-label text-[11px] text-muted text-center border-t-2 border-ink break-words leading-relaxed">
            FIRST-TIME APPROVAL: GRANTS UNLIMITED USDC SPEND TO MAKO ·
            GAS COVERED BY MAKO
          </div>
        )}
        {flow === 'magic' && (allowanceBn >= betUsdc || betUsdc === 0n) && phase === 'idle' && (
          <div className="px-4 py-2 mako-label text-[11px] text-muted text-center border-t-2 border-ink">
            GAS COVERED BY MAKO
          </div>
        )}

        {/* Non-busy status (success / error / submitted-info).
            `submitted` is the Magic-flow non-blocking case where the
            bundler accepted but receipt poll timed out — visually
            distinct from error so the user understands the bet is
            probably fine, just slow. Group 5 round-1 MAJOR 2 fix. */}
        {statusText && !isBusy && (
          <div
            className={`px-4 py-2 mako-label text-center border-t-2 border-ink break-words ${
              phase === 'success'
                ? 'bg-signal/30 text-ink'
                : phase === 'submitted'
                  ? 'bg-paper text-muted'
                  : 'bg-mako-red/15 text-mako-red'
            }`}
          >
            {statusText}
          </div>
        )}

        {/* Dismiss button for the submitted state so the user isn't
            visually stuck. Resets to idle, freeing the BetSheet for
            another bet (the partial unique index will block until the
            cron resolves the in-flight row, but that's the route's
            problem, not the UI's). */}
        {phase === 'submitted' && (
          <button
            type="button"
            onClick={reset}
            className="w-full px-4 py-2 mako-label text-[11px] text-center border-t-2 border-ink bg-paper hover:bg-surface-elevated"
          >
            DISMISS
          </button>
        )}

        {/* Tx hash chips for debugging — hidden in release polish */}
        {betHash && phase === 'awaitingBet' && (
          <div className="px-4 py-1 mako-label text-[10px] text-muted text-center break-all">
            {betHash}
          </div>
        )}
      </div>
    </div>
  );
}
