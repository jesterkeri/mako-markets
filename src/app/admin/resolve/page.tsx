'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useWaitForTransactionReceipt } from 'wagmi';
import { useMarkets, useResolveMarket } from '@/lib/hooks';
import { Outcome, type MarketWithId } from '@/lib/contract';
import { useIsAdmin, ADMIN_ADDRESS } from '@/lib/admin';
import { useAdminSession } from '@/lib/use-admin-session';
import { formatUsdc } from '@/lib/usdc';
import { AdminNav } from '@/components/AdminNav';
import { AdminLogin } from '@/components/AdminLogin';

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
  const { data: session } = useAdminSession({ enabled: isAdmin });
  const { markets, isLoading, refetch } = useMarkets();

  const pending = useMemo(() => {
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    return markets.filter((m) => !m.resolved && m.closeTime <= nowSec);
  }, [markets]);

  if (!isAdmin) {
    return (
      <main className="flex-1 flex flex-col items-center justify-center gap-6 py-20 px-6 text-center">
        <div className="-rotate-2">
          <div className="bg-paper border-2 border-ink rounded-2xl shadow-brutal p-8 max-w-sm">
            <h1 className="mako-display text-3xl mb-3">NOT AUTHORIZED</h1>
            <p className="mako-body text-muted mb-3">
              Connect the deployer wallet to resolve markets.
            </p>
            <p className="mako-mono text-[10px] text-subtle break-all">
              ADMIN: {ADMIN_ADDRESS}
            </p>
          </div>
        </div>
        <Link href="/" className="mako-button mako-button--signal mako-label">
          BACK TO FEED
        </Link>
      </main>
    );
  }

  // SIWE session gate. The resolve page doesn't hit /api/admin/analytics,
  // so we can't learn session state from that query's 401 — probe /api/auth/me
  // instead. First render: session is undefined → show AdminLogin while the
  // probe runs (safe default). Once authed resolves true, show the page.
  if (session?.authed !== true) return <AdminLogin />;

  return (
    <main className="flex-1 flex flex-col w-full pb-16">
      <AdminNav active="resolve" />

      <div className="px-6 lg:px-8 py-8 border-b-2 border-ink">
        <div className="mako-label text-muted mb-2">ADMIN · RESOLVE</div>
        <h1 className="mako-display text-3xl md:text-4xl mb-2 text-canvas-fg">
          {pending.length} PENDING
        </h1>
        <p className="mako-label text-muted">
          MARKET{pending.length !== 1 ? 'S' : ''} PAST CLOSE · AWAITING OUTCOME
        </p>
      </div>

      {isLoading && markets.length === 0 ? (
        <div className="py-20 text-center mako-label text-muted border-b-2 border-ink">
          LOADING MARKETS…
        </div>
      ) : pending.length === 0 ? (
        <div className="py-20 text-center mako-label text-muted border-b-2 border-ink">
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

  const poolUsdc = formatUsdc(market.totalYes + market.totalNo, 4);
  const yesUsdc = formatUsdc(market.totalYes, 4);
  const noUsdc = formatUsdc(market.totalNo, 4);

  return (
    <div className="border-b-2 border-ink/10 px-4 lg:px-8 py-4">
      <div className="bg-paper border-2 border-ink rounded-2xl shadow-brutal overflow-hidden">
        <div className="px-6 py-5 bg-surface-elevated border-b-2 border-ink">
          <div className="mako-label text-muted mb-1">
            ID {market.id.toString()} · POOL {poolUsdc} USDC
          </div>
          <h2 className="mako-title text-lg leading-tight">{market.question}</h2>
          <div className="mako-label text-muted mt-3 flex gap-6">
            <span>
              YES <span className="text-ink tabular-nums">{yesUsdc}</span>
            </span>
            <span>
              NO <span className="text-ink tabular-nums">{noUsdc}</span>
            </span>
            <span>
              BETTORS{' '}
              <span className="text-ink tabular-nums">
                {market.yesBettorCount + market.noBettorCount}
              </span>
            </span>
          </div>
        </div>

        <div className="grid grid-cols-3 border-b-2 border-ink">
          <button
            type="button"
            disabled={disabled}
            onClick={() => handleResolve(Outcome.YES)}
            className="py-4 mako-label border-r-2 border-ink bg-paper hover:bg-ink hover:text-canvas-fg transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            RESOLVE YES
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => handleResolve(Outcome.NO)}
            className="py-4 mako-label border-r-2 border-ink bg-paper hover:bg-mako-red hover:text-canvas-fg transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            RESOLVE NO
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => handleResolve(Outcome.REFUND)}
            className="py-4 mako-label bg-paper hover:bg-ink hover:text-canvas-fg transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            REFUND
          </button>
        </div>

        {statusText && (
          <div
            className={`px-6 py-2 mako-label text-center break-words ${
              isSuccess ? 'bg-signal text-ink' : error ? 'bg-mako-red/15 text-mako-red' : 'text-muted bg-paper'
            }`}
          >
            {statusText}
          </div>
        )}
      </div>
    </div>
  );
}
