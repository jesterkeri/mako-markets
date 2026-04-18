'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useWaitForTransactionReceipt } from 'wagmi';
import { useMarkets, useResolveMarket } from '@/lib/hooks';
import { Outcome, type MarketWithId } from '@/lib/contract';
import { useIsAdmin, ADMIN_ADDRESS } from '@/lib/admin';
import { formatEther } from 'viem';
import { AdminNav } from '@/components/AdminNav';

/**
 * Admin-only resolve UI.
 *
 * Lists all markets past their `closeTime` that haven't been resolved yet.
 * One tap per market to Resolve YES / Resolve NO / Refund.
 *
 * IMPORTANT: the client-side `useIsAdmin()` gate is cosmetic. See the
 * file header of `src/lib/admin.ts`. Authorization is enforced on-chain
 * by the `onlyResolver` modifier in MakoMarkets.sol — any non-resolver
 * calling `resolveMarket(...)` reverts with `NotResolver()`.
 */
export default function AdminResolvePage() {
  const isAdmin = useIsAdmin();
  const { markets, isLoading, refetch } = useMarkets();

  const pending = useMemo(() => {
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    return markets.filter((m) => !m.resolved && m.closeTime <= nowSec);
  }, [markets]);

  if (!isAdmin) {
    return (
      <main className="flex-1 flex flex-col items-center justify-center gap-4 py-16 px-6 text-center">
        <h1 className="text-3xl font-black uppercase tracking-tight">NOT AUTHORIZED</h1>
        <p className="text-muted text-xs font-bold uppercase tracking-widest">
          CONNECT THE DEPLOYER WALLET TO RESOLVE MARKETS
        </p>
        <p className="text-[10px] font-mono text-subtle break-all max-w-xs">
          ADMIN: {ADMIN_ADDRESS}
        </p>
        <Link
          href="/"
          className="mt-4 bg-black text-background font-black text-[11px] uppercase tracking-widest px-6 py-3 hover:bg-transparent hover:text-foreground border border-black transition-colors"
        >
          BACK TO FEED
        </Link>
      </main>
    );
  }

  return (
    <main className="flex-1 flex flex-col w-full pb-16">
      <div className="px-6 md:px-8 py-4 border-b border-black">
        <Link
          href="/"
          className="text-foreground text-sm font-black uppercase tracking-widest hover:bg-black hover:text-background px-2 py-1 -ml-2 inline-block transition-colors"
        >
          &lt; BACK
        </Link>
      </div>

      <AdminNav active="resolve" />

      <div className="px-6 md:px-8 py-8 border-b border-black">
        <div className="text-[10px] font-black uppercase tracking-widest text-muted mb-2">
          [ ADMIN · RESOLVE ]
        </div>
        <h1 className="text-3xl font-black uppercase tracking-tight">
          {pending.length} PENDING
        </h1>
        <p className="text-muted text-[11px] font-bold uppercase tracking-widest mt-2">
          MARKET{pending.length !== 1 ? 'S' : ''} PAST CLOSE · AWAITING OUTCOME
        </p>
      </div>

      {isLoading && markets.length === 0 ? (
        <div className="py-20 text-center font-black uppercase tracking-widest text-muted text-sm border-b border-black">
          LOADING MARKETS…
        </div>
      ) : pending.length === 0 ? (
        <div className="py-20 text-center font-black uppercase tracking-widest text-muted text-sm border-b border-black">
          NO PENDING MARKETS
        </div>
      ) : (
        pending.map((market) => (
          <ResolveRow
            key={market.id.toString()}
            market={market}
            onResolved={refetch}
          />
        ))
      )}
    </main>
  );
}

function ResolveRow({
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

  const handleResolve = async (outcome: Outcome) => {
    setLastAction(Outcome[outcome]);
    try {
      await resolve({ id: market.id, outcome });
    } catch (e) {
      console.error('[admin-resolve] failed:', e);
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
          ? `ERROR: ${(error as Error).message.slice(0, 100).toUpperCase()}`
          : null;

  const poolMon = Number(formatEther(market.totalYes + market.totalNo));
  const yesMon = Number(formatEther(market.totalYes));
  const noMon = Number(formatEther(market.totalNo));

  return (
    <div className="border-b border-black">
      <div className="px-6 md:px-8 py-5">
        <div className="text-[10px] font-black uppercase tracking-widest text-muted mb-1">
          ID {market.id.toString()} · POOL {poolMon.toFixed(4)} MON
        </div>
        <h2 className="text-xl font-black uppercase leading-tight">{market.question}</h2>
        <div className="text-[10px] font-black uppercase tracking-widest text-muted mt-3 flex gap-6">
          <span>
            YES <span className="text-foreground tabular-nums">{yesMon.toFixed(4)}</span>
          </span>
          <span>
            NO <span className="text-foreground tabular-nums">{noMon.toFixed(4)}</span>
          </span>
          <span>
            BETTORS{' '}
            <span className="text-foreground tabular-nums">
              {market.yesBettorCount + market.noBettorCount}
            </span>
          </span>
        </div>
      </div>

      <div className="flex flex-row divide-x divide-black border-t border-black">
        <button
          type="button"
          disabled={disabled}
          onClick={() => handleResolve(Outcome.YES)}
          className="flex-1 py-4 font-black uppercase tracking-widest text-xs transition-colors disabled:opacity-30 disabled:cursor-not-allowed hover:bg-black hover:text-background"
        >
          RESOLVE YES
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => handleResolve(Outcome.NO)}
          className="flex-1 py-4 font-black uppercase tracking-widest text-xs transition-colors disabled:opacity-30 disabled:cursor-not-allowed hover:bg-black hover:text-background"
        >
          RESOLVE NO
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => handleResolve(Outcome.REFUND)}
          className="flex-1 py-4 font-black uppercase tracking-widest text-xs transition-colors disabled:opacity-30 disabled:cursor-not-allowed hover:bg-black hover:text-background"
        >
          REFUND
        </button>
      </div>

      {statusText && (
        <div
          className={`px-6 py-2 border-t border-black text-[10px] font-black uppercase tracking-widest text-center break-words ${
            isSuccess ? 'bg-yes/15 text-yes' : error ? 'bg-warning/15 text-warning' : 'text-muted'
          }`}
        >
          {statusText}
        </div>
      )}
    </div>
  );
}
