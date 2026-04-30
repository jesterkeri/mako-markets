'use client';

import { useEffect, useState } from 'react';
import { useWaitForTransactionReceipt } from 'wagmi';
import { Outcome, type MarketWithId } from '@/lib/contract';
import { useResolveMarket } from '@/lib/hooks';

/**
 * Reusable inline resolve action row.
 *
 * Renders three buttons (YES / NO / REFUND) in a horizontal strip,
 * styled to match Gemini's brutalist feed aesthetic. Owns its own
 * `useResolveMarket` + `useWaitForTransactionReceipt` hooks so
 * multiple instances can coexist on the same page (e.g. a list of
 * pending markets in /me or /admin/resolve).
 *
 * Caller is responsible for only rendering this when the connected
 * wallet is the admin AND the market is closed-and-unresolved — this
 * component does NOT gate on those conditions itself. The on-chain
 * `onlyResolver` modifier is the real authorization.
 */
export function MarketResolveActions({
  market,
  onResolved,
}: {
  market: MarketWithId;
  onResolved: () => void;
}) {
  const { resolve, hash, isPending, error, reset } = useResolveMarket();
  const { isLoading: isWaiting, isSuccess } = useWaitForTransactionReceipt({ hash });
  const [lastAction, setLastAction] = useState<string | null>(null);

  useEffect(() => {
    if (!isSuccess) return;
    onResolved();
    const t = setTimeout(() => reset(), 2500);
    return () => clearTimeout(t);
  }, [isSuccess, onResolved, reset]);

  const handleResolve = async (e: React.MouseEvent, outcome: Outcome) => {
    // Stop propagation so the click doesn't bubble up to the parent
    // <Link> wrapper (if any) and trigger navigation away from the page.
    e.preventDefault();
    e.stopPropagation();
    setLastAction(Outcome[outcome]);
    try {
      await resolve({ id: market.id, outcome });
    } catch (err) {
      console.error('[resolve-actions] failed:', err);
    }
  };

  const isBusy = isPending || isWaiting;
  const disabled = isBusy || isSuccess;

  const statusText = isPending
    ? `CONFIRMING ${lastAction ?? ''}…`
    : isWaiting
      ? 'TX LANDING…'
      : isSuccess
        ? 'RESOLVED ✓'
        : error
          ? `ERROR: ${(error as Error).message.slice(0, 80).toUpperCase()}`
          : null;

  return (
    <div className="border-t border-warning bg-warning/5">
      <div className="px-6 md:px-8 py-2.5 text-[10px] font-black uppercase tracking-widest text-warning text-center">
        [ ADMIN · PICK OUTCOME ]
      </div>
      <div className="flex flex-row divide-x divide-canvas-divider border-t border-canvas-divider">
        <button
          type="button"
          disabled={disabled}
          onClick={(e) => handleResolve(e, Outcome.YES)}
          className="flex-1 py-3 font-black uppercase tracking-widest text-[11px] text-canvas-fg transition-colors disabled:opacity-30 disabled:cursor-not-allowed hover:bg-canvas-fg hover:text-canvas"
        >
          RESOLVE YES
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={(e) => handleResolve(e, Outcome.NO)}
          className="flex-1 py-3 font-black uppercase tracking-widest text-[11px] text-canvas-fg transition-colors disabled:opacity-30 disabled:cursor-not-allowed hover:bg-canvas-fg hover:text-canvas"
        >
          RESOLVE NO
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={(e) => handleResolve(e, Outcome.REFUND)}
          className="flex-1 py-3 font-black uppercase tracking-widest text-[11px] text-canvas-fg transition-colors disabled:opacity-30 disabled:cursor-not-allowed hover:bg-canvas-fg hover:text-canvas"
        >
          REFUND
        </button>
      </div>
      {statusText && (
        <div
          className={`px-6 py-2 border-t border-canvas-divider text-[10px] font-black uppercase tracking-widest text-center break-words ${
            isSuccess
              ? 'bg-yes/15 text-yes'
              : error
                ? 'bg-warning/15 text-warning'
                : 'text-muted'
          }`}
        >
          {statusText}
        </div>
      )}
    </div>
  );
}
