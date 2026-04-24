'use client';

import { useState, useMemo, useEffect } from 'react';
import { parseEther, formatEther } from 'viem';
import { useReadContracts, useWaitForTransactionReceipt } from 'wagmi';
import { makoContract, type MarketWithId } from '@/lib/contract';
import { usePlaceBet } from '@/lib/hooks';
import { computePayoutWei, computeMinLiquidityRatioBps } from '@/lib/bet';

/**
 * Fixed-bottom bet sheet. Renders within the mobile container width.
 * Amount input + live bigint payout preview + PLACE BET.
 *
 * The YES / NO side selector lives in the parent detail page — the big
 * multiplier blocks above double as the side picker. We accept `side` as
 * a prop rather than owning it locally so there is exactly one selector.
 *
 * - Reads `protocolFeeBps` + `creatorFeeBps` once on mount (cached).
 * - Recomputes preview on every keystroke via `computePayoutWei`.
 * - On submit: `usePlaceBet()` → `useWaitForTransactionReceipt` → refetch.
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

  const { data: feeData } = useReadContracts({
    contracts: [
      { ...makoContract, functionName: 'protocolFeeBps' },
      { ...makoContract, functionName: 'creatorFeeBps' },
    ],
  });

  const { feeBps, minRatioBps } = useMemo(() => {
    const protocolBps = BigInt((feeData?.[0]?.result as number | undefined) ?? 200);
    const creatorBps = BigInt((feeData?.[1]?.result as number | undefined) ?? 100);
    return {
      feeBps: protocolBps + creatorBps,
      minRatioBps: computeMinLiquidityRatioBps(creatorBps),
    };
  }, [feeData]);

  const betWei = useMemo(() => {
    try {
      return parseEther(amount || '0');
    } catch {
      return 0n;
    }
  }, [amount]);

  const payoutWei = useMemo(
    () =>
      computePayoutWei(
        market.totalYes,
        market.totalNo,
        betWei,
        side === 'yes',
        feeBps,
        minRatioBps,
      ),
    [market.totalYes, market.totalNo, betWei, side, feeBps, minRatioBps],
  );

  const profitWei = payoutWei > betWei ? payoutWei - betWei : 0n;
  const wouldRefund = betWei > 0n && payoutWei === betWei;

  const { placeBet, hash, isPending, error, reset } = usePlaceBet();
  const { isLoading: isWaiting, isSuccess } = useWaitForTransactionReceipt({ hash });

  useEffect(() => {
    if (!isSuccess) return;
    onSuccess?.();
    const t = setTimeout(() => reset(), 2500);
    return () => clearTimeout(t);
  }, [isSuccess, onSuccess, reset]);

  const handlePlaceBet = async () => {
    if (betWei === 0n) return;
    try {
      await placeBet({
        id: market.id,
        isYes: side === 'yes',
        amountMon: amount,
      });
    } catch (e) {
      console.error('[bet-sheet] placeBet failed:', e);
    }
  };

  const disabled = isPending || isWaiting || betWei === 0n;
  const isBusy = isPending || isWaiting;

  const statusText = isPending
    ? 'CONFIRM IN WALLET…'
    : isWaiting
      ? 'TX LANDING…'
      : isSuccess
        ? 'BET PLACED ✓'
        : error
          ? `ERROR: ${(error as Error).message.slice(0, 100).toUpperCase()}`
          : null;

  // bottom-9 (36px) clears the fixed PriceTicker pinned to the viewport
  // bottom. Stacking them vertically avoids the ticker drawing on top of
  // the PLACE BET button.
  return (
    <div className="fixed bottom-9 left-1/2 -translate-x-1/2 w-full max-w-md z-40 px-4">
      <div className="bg-paper border-2 border-ink rounded-2xl shadow-[4px_4px_0_0_#000000] overflow-hidden">
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
          <span className="mako-label text-muted">MON</span>
        </div>

        {/* Payout preview */}
        <div className="px-5 py-3 border-b-2 border-ink bg-paper mako-label leading-relaxed">
          {betWei === 0n ? (
            <span className="text-muted">ENTER AMOUNT TO PREVIEW PAYOUT</span>
          ) : wouldRefund ? (
            <span className="text-mako-red">POOL TOO THIN · WOULD REFUND AT RESOLVE</span>
          ) : (
            <div className="flex justify-between gap-4">
              <div className="text-muted">
                WIN{' '}
                <span className="text-ink tabular-nums ml-1">
                  {Number(formatEther(payoutWei)).toFixed(4)}
                </span>
              </div>
              <div className="text-muted">
                PROFIT{' '}
                <span className="text-ink tabular-nums ml-1">
                  +{Number(formatEther(profitWei)).toFixed(4)}
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
          {isBusy
            ? statusText
            : `PLACE BET · ${amount || '0'} MON ${side.toUpperCase()}`}
        </button>

        {/* Non-busy status (success / error) */}
        {statusText && !isBusy && (
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
