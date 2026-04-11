'use client';

import { useState, useMemo, useEffect } from 'react';
import { parseEther, formatEther } from 'viem';
import { useReadContracts, useWaitForTransactionReceipt } from 'wagmi';
import { makoContract, type MarketWithId } from '@/lib/contract';
import { usePlaceBet } from '@/lib/hooks';
import { computePayoutWei, computeMinLiquidityRatioBps } from '@/lib/bet';

/**
 * Fixed-bottom bet sheet. Renders over the viewport within the mobile
 * container width. Amount input + live client-side bigint payout preview
 * + Place Bet button.
 *
 * The YES / NO side selector lives in the parent detail page — the big
 * multiplier blocks above double as the side picker (cannibal.gg pattern).
 * We accept `side` as a prop rather than owning it locally so there is
 * exactly one selector in the UI, not two.
 *
 * - Reads `protocolFeeBps` + `creatorFeeBps` once on mount (cached).
 * - Recomputes preview on every keystroke via `computePayoutWei` (pure
 *   bigint, no RPC).
 * - On submit: `usePlaceBet()` → `useWaitForTransactionReceipt` → refetch.
 * - Detects the thin-liquidity refund path and warns the user that the
 *   pool would refund at settlement instead of paying out.
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

  // Live fee config — one batched read, wagmi caches indefinitely.
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

  // Parse input to wei; fallback to 0 on malformed input so preview clears.
  const betWei = useMemo(() => {
    try {
      return parseEther(amount || '0');
    } catch {
      return 0n;
    }
  }, [amount]);

  // Pure bigint payout preview.
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
  // computePayoutWei returns betWei as-is when the pool would refund.
  const wouldRefund = betWei > 0n && payoutWei === betWei;

  const { placeBet, hash, isPending, error, reset } = usePlaceBet();
  const { isLoading: isWaiting, isSuccess } = useWaitForTransactionReceipt({ hash });

  // Fire onSuccess when the tx receipt lands, then reset for next bet.
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
      // error surfaces via hook state
      console.error('[bet-sheet] placeBet failed:', e);
    }
  };

  const disabled = isPending || isWaiting || betWei === 0n;

  const statusText = isPending
    ? 'CONFIRM IN WALLET...'
    : isWaiting
      ? 'TX LANDING...'
      : isSuccess
        ? 'BET PLACED ✓'
        : error
          ? `ERROR: ${(error as Error).message.slice(0, 100).toUpperCase()}`
          : null;

  const isBusy = isPending || isWaiting;

  return (
    <div className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-md z-40 bg-background border-t border-black shadow-[0_-4px_0_rgba(0,0,0,0.05)]">
      {/* Amount input */}
      <div className="px-6 py-3 border-b border-black flex items-center gap-3 bg-surface">
        <label
          htmlFor="bet-amount"
          className="text-[10px] font-black uppercase tracking-widest text-muted"
        >
          AMOUNT
        </label>
        <input
          id="bet-amount"
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
          disabled={isBusy}
          className="flex-1 min-w-0 bg-transparent border-0 outline-none text-2xl font-black tabular-nums text-foreground disabled:opacity-50"
          placeholder="0"
        />
        <span className="text-xs font-black uppercase tracking-widest text-muted">MON</span>
      </div>

      {/* Payout preview */}
      <div className="px-6 py-3 border-b border-black bg-surface text-[11px] font-black uppercase tracking-widest leading-relaxed">
        {betWei === 0n ? (
          <span className="text-muted">ENTER AMOUNT TO PREVIEW PAYOUT</span>
        ) : wouldRefund ? (
          <span className="text-warning">
            POOL TOO THIN · WOULD REFUND STAKE AT RESOLVE
          </span>
        ) : (
          <div className="flex justify-between gap-4">
            <div className="text-muted">
              WIN:{' '}
              <span className="text-foreground">
                {Number(formatEther(payoutWei)).toFixed(4)} MON
              </span>
            </div>
            <div className="text-muted">
              PROFIT:{' '}
              <span className="text-foreground">
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
        className={`w-full py-4 font-black uppercase tracking-widest text-sm transition-colors ${
          disabled
            ? 'bg-black/20 text-muted cursor-not-allowed'
            : 'bg-black text-background hover:bg-foreground/90'
        }`}
      >
        {isBusy
          ? statusText
          : `PLACE BET · ${amount || '0'} MON ${side.toUpperCase()}`}
      </button>

      {/* Non-busy status (success / error) */}
      {statusText && !isBusy && (
        <div
          className={`px-4 py-2 text-[10px] font-black uppercase tracking-widest text-center border-t border-black break-words ${
            isSuccess
              ? 'bg-yes/15 text-yes'
              : 'bg-warning/15 text-warning'
          }`}
        >
          {statusText}
        </div>
      )}
    </div>
  );
}
