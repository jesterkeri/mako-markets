'use client';

import { useState, useMemo, useEffect } from 'react';
import { useAccount } from 'wagmi';
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
 * Fixed-bottom bet sheet for an external-wallet (RainbowKit) flow.
 *
 * v4 bet path:
 *   1. user types amount → live `computePreviewPayout` shows expected return
 *   2. on submit, `usePlaceBet` runs ensure-allowance-then-bet (2 sequential
 *      txs: approve once if needed, then placeBet)
 *   3. simulate-time reverts (`BettingClosed`, `WalletCapExceeded`, etc.) are
 *      decoded into a clean error message and shown without the user spending
 *      gas on a known-revert bet tx
 *
 * Per-market fee snapshots flow into `computePreviewPayout` SEPARATELY (NOT
 * summed) so the helper can apply v4's creator-fee-forfeit rule on skewed pools.
 *
 * **Approval policy:** infinite (`MaxUint256`). One approve covers all future
 * bets — standard pattern (Uniswap, Polymarket). Trade-off: if MakoMarkets
 * is later compromised, the approval lets it drain the wallet's USDC.
 * Acceptable for testnet beta; production cutover should reconsider.
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
  const { address } = useAccount();

  const { data: balance, refetch: refetchBalance } = useUsdcBalance(address);
  const { data: allowance, refetch: refetchAllowance } = useUsdcAllowance(address);

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

  const { placeBet, phase, betHash, error, reset } = usePlaceBet();

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
    if (address && betUsdc > balanceBn) return { ok: false, reason: 'balance' };
    return { ok: true };
  }, [betUsdc, balanceBn, address]);

  const needsApprove = address ? allowanceBn < betUsdc : true;

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
  // Also disable while showing the post-success "BET PLACED ✓" badge so a
  // click during the 2.5s success window can't fire a second placeBet
  // before reset() flips us back to idle.
  const disabled = isBusy || phase === 'success' || !validation.ok;

  const buttonLabel = (() => {
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
  const statusText = isBusy ? buttonLabel : successText ?? errorText;

  return (
    <div className="fixed bottom-9 left-1/2 -translate-x-1/2 w-full max-w-md z-40 px-4">
      <div className="bg-paper border-2 border-ink rounded-2xl shadow-brutal overflow-hidden">
        {/* Balance pill — only when wallet connected */}
        {address && (
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

        {/* Non-busy status (success / error) */}
        {statusText && !isBusy && (
          <div
            className={`px-4 py-2 mako-label text-center border-t-2 border-ink break-words ${
              phase === 'success' ? 'bg-signal/30 text-ink' : 'bg-mako-red/15 text-mako-red'
            }`}
          >
            {statusText}
          </div>
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
