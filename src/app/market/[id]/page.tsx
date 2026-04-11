'use client';

import { use, useState, useEffect } from 'react';
import Link from 'next/link';
import { useWaitForTransactionReceipt } from 'wagmi';
import { useMarket, useResolveMarket } from '@/lib/hooks';
import { MarketType, Outcome, type MarketWithId } from '@/lib/contract';
import { useIsAdmin } from '@/lib/admin';
import { yesMultiplier, noMultiplier, secondsLeft, poolSizeMon } from '@/lib/mocks';
import { formatEther } from 'viem';
import { BetSheet } from '@/components/BetSheet';
import { ClaimButton } from '@/components/ClaimButton';
import { ShareMarketButton } from '@/components/ShareMarketButton';

// Next.js 16 client-component dynamic route params are delivered as a Promise.
// Use React's `use()` to unwrap synchronously per node_modules/next/dist/docs/
// 01-app/03-api-reference/03-file-conventions/dynamic-routes.md.
export default function MarketDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

  // Parse the id BEFORE any hooks so `useMarket` is called unconditionally
  // every render. React Hooks rules require the same hook call order every
  // render — an early return between `use(params)` and `useMarket()` would
  // skip the hook on invalid-id paths and trip `react-hooks/rules-of-hooks`.
  let parsedId: bigint | null = null;
  try {
    parsedId = BigInt(id);
  } catch {
    /* keep null, handled below */
  }

  // Call `useMarket` unconditionally. When `parsedId` is null we pass `0n`
  // as a placeholder id — the NotFound render below prevents anything from
  // actually consuming the stale data.
  const { market, isLoading, refetch } = useMarket(parsedId ?? 0n);

  // Which side the user is betting on. Lifted up from BetSheet so the
  // YES / NO multiplier blocks above can double as the side selector
  // (cannibal.gg pattern — one set of controls, not two).
  const [betSide, setBetSide] = useState<'yes' | 'no'>('yes');

  if (parsedId === null) {
    return <NotFound reason={`Invalid market id: ${id}`} />;
  }
  const marketId = parsedId;
  void marketId; // available for any downstream code that still references it

  if (isLoading && !market) {
    return (
      <main className="flex-1 flex flex-col pt-6 px-6 md:px-8 border-b border-black">
        <Link href="/" className="text-foreground hover:bg-black hover:text-background text-sm font-bold uppercase tracking-widest px-2 py-1 w-fit border border-transparent hover:border-black transition-colors">
          [ BACK ]
        </Link>
        <div className="py-20 text-center font-black uppercase tracking-widest text-muted text-sm">
          LOADING MARKET #{id}...
        </div>
      </main>
    );
  }

  if (!market) {
    return <NotFound reason={`Market #${id} not found on-chain.`} />;
  }

  const poolSize = poolSizeMon(market);
  const yesMult = yesMultiplier(market);
  const noMult = noMultiplier(market);
  const timeLeft = secondsLeft(market);
  const totalBettors = market.yesBettorCount + market.noBettorCount;
  const isWarning = timeLeft > 0 && timeLeft <= 15;
  const isClosed = timeLeft <= 0 || market.resolved;

  const badgeText =
    market.mType === MarketType.FOOTBALL ? 'FOOTBALL'
    : market.mType === MarketType.CRYPTO ? 'CRYPTO'
    : 'AD-HOC';

  const statusLabel = market.resolved
    ? `RESOLVED: ${Outcome[market.outcome]}`
    : timeLeft > 0
      ? formatTime(timeLeft)
      : 'AWAITING RESOLUTION';

  return (
    <main className="flex-1 flex flex-col w-full bg-transparent pb-32">
      <div className="px-6 md:px-8 py-4 border-b border-black">
        <Link href="/" className="text-foreground hover:bg-black hover:text-background text-sm font-bold uppercase tracking-widest px-2 py-1 w-fit transition-colors -ml-2 inline-block">
          &lt; BACK
        </Link>
      </div>

      <div className="flex justify-between items-center px-6 md:px-8 py-2.5 border-b border-black bg-surface">
        <span className={`text-[11px] font-black tracking-widest uppercase ${isClosed ? 'text-muted' : 'text-foreground'}`}>
          {badgeText}
        </span>
        <span
          className={`text-[11px] font-black tracking-widest uppercase ${isWarning ? 'text-warning' : isClosed ? 'text-muted' : 'text-foreground'}`}
        >
          {statusLabel}
        </span>
      </div>

      <div className="px-6 md:px-8 py-8 border-b border-black bg-transparent">
        <h1 className="text-4xl font-black text-foreground uppercase leading-[1.05] tracking-tight">
          {market.question}
        </h1>
      </div>

      <div className="grid grid-cols-2 divide-x divide-black border-b border-black">
        <ShareMarketButton marketId={market.id} />
        <Link
          href="/create"
          className="py-3 px-4 font-black text-[11px] uppercase tracking-widest hover:bg-black hover:text-background transition-colors text-center"
        >
          [ NEW MARKET ]
        </Link>
      </div>

      <div className="flex flex-row border-b border-black divide-x divide-black w-full relative z-0">
        <button
          type="button"
          onClick={() => setBetSide('yes')}
          disabled={isClosed}
          className={`flex-[0.5] stretch flex flex-col items-start text-left pl-6 md:pl-8 pr-4 py-6 transition-colors cursor-pointer group disabled:cursor-not-allowed disabled:opacity-50 ${
            betSide === 'yes' && !isClosed
              ? 'bg-black text-background'
              : 'hover:bg-black hover:text-background'
          }`}
        >
          <span className="text-xs font-black uppercase tracking-widest mb-3">YES</span>
          <span className="text-4xl font-black tabular-nums tracking-tighter leading-none">
            {yesMult > 0 ? `${yesMult.toFixed(2)}x` : '-'}
          </span>
          <span
            className={`text-[10px] font-bold mt-2 tabular-nums uppercase ${
              betSide === 'yes' && !isClosed ? 'text-subtle' : 'text-muted group-hover:text-subtle'
            }`}
          >
            {formatEther(market.totalYes)} MON
          </span>
        </button>
        <button
          type="button"
          onClick={() => setBetSide('no')}
          disabled={isClosed}
          className={`flex-[0.5] stretch flex flex-col items-start text-left pr-6 md:pr-8 pl-4 py-6 transition-colors cursor-pointer group disabled:cursor-not-allowed disabled:opacity-50 ${
            betSide === 'no' && !isClosed
              ? 'bg-black text-background'
              : 'hover:bg-black hover:text-background'
          }`}
        >
          <span className="text-xs font-black uppercase tracking-widest mb-3">NO</span>
          <span className="text-4xl font-black tabular-nums tracking-tighter leading-none">
            {noMult > 0 ? `${noMult.toFixed(2)}x` : '-'}
          </span>
          <span
            className={`text-[10px] font-bold mt-2 tabular-nums uppercase ${
              betSide === 'no' && !isClosed ? 'text-subtle' : 'text-muted group-hover:text-subtle'
            }`}
          >
            {formatEther(market.totalNo)} MON
          </span>
        </button>
      </div>

      <div className="flex flex-wrap border-b border-black divide-x divide-y divide-black text-[11px] font-black uppercase tracking-widest w-full bg-surface">
        <div className="w-[50%] p-3 pl-6 md:pl-8 flex flex-col gap-1.5">
          <span className="text-muted">POOL</span>
          <span className="text-foreground tabular-nums">${poolSize.toFixed(2)} MON</span>
        </div>
        <div className="w-[50%] p-3 pl-4 flex flex-col gap-1.5 border-t-0">
          <span className="text-muted">BETTORS</span>
          <span className="text-foreground tabular-nums">{totalBettors}</span>
        </div>
        <div className="w-[50%] p-3 pl-6 md:pl-8 flex flex-col gap-1.5 border-t">
          <span className="text-muted">YES COUNT</span>
          <span className="text-foreground tabular-nums">{market.yesBettorCount}</span>
        </div>
        <div className="w-[50%] p-3 pl-4 flex flex-col gap-1.5 border-t">
          <span className="text-muted">NO COUNT</span>
          <span className="text-foreground tabular-nums">{market.noBettorCount}</span>
        </div>
      </div>

      <div className="px-6 md:px-8 py-4 border-b border-black text-[10px] text-muted font-mono break-all leading-relaxed bg-surface hover:bg-black hover:text-background transition-colors cursor-pointer">
        CREATED BY {market.creator}
      </div>

      {/* In-flow banner + admin inline resolve for markets past closeTime but not yet resolved */}
      {!market.resolved && isClosed && (
        <AwaitingResolutionPanel market={market} onResolved={refetch} />
      )}

      {/* Fixed-bottom action UI — BetSheet for open markets, ClaimButton for resolved */}
      {market.resolved ? (
        <ClaimButton market={market} onSuccess={refetch} />
      ) : !isClosed ? (
        <BetSheet market={market} side={betSide} onSuccess={refetch} />
      ) : null}
    </main>
  );
}

/**
 * Inline "awaiting resolution" panel. Non-admins see a passive warning.
 * Admins see three one-tap resolve buttons (YES / NO / REFUND) that call
 * `resolveMarket` on this specific market without leaving the page.
 * Saves a round trip to /admin/resolve for the demo flow.
 */
function AwaitingResolutionPanel({
  market,
  onResolved,
}: {
  market: MarketWithId;
  onResolved: () => void;
}) {
  const isAdmin = useIsAdmin();
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
      console.error('[detail-resolve] failed:', e);
    }
  };

  const isBusy = isPending || isWaiting;
  const disabled = isBusy || isSuccess;

  const statusText = isPending
    ? `CONFIRMING ${lastAction ?? ''}…`
    : isWaiting
      ? 'TX LANDING…'
      : isSuccess
        ? 'RESOLVED ✓ · REFRESHING…'
        : error
          ? `ERROR: ${(error as Error).message.slice(0, 80).toUpperCase()}`
          : null;

  // Non-admin: passive banner
  if (!isAdmin) {
    return (
      <div className="px-6 md:px-8 py-8 border-t border-warning bg-warning/10 text-center">
        <span className="block text-xs font-black tracking-widest text-warning uppercase mb-2">
          [ AWAITING RESOLUTION ]
        </span>
        <span className="block text-[11px] font-medium text-muted uppercase tracking-tight">
          MARKET CLOSED · ADMIN WILL RESOLVE SHORTLY
        </span>
      </div>
    );
  }

  // Admin: inline three-button resolve
  return (
    <div className="border-t border-warning">
      <div className="px-6 md:px-8 py-5 bg-warning/10 text-center">
        <span className="block text-xs font-black tracking-widest text-warning uppercase mb-1">
          [ ADMIN · PICK OUTCOME ]
        </span>
        <span className="block text-[10px] font-medium text-muted uppercase tracking-tight">
          ONE TAP TO RESOLVE · CONTRACT FORCES REFUND ON ONE-SIDED POOLS
        </span>
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

function NotFound({ reason }: { reason: string }) {
  return (
    <main className="flex-1 flex flex-col items-center justify-center gap-4 text-center py-16 px-6 border-b border-black">
      <h1 className="text-3xl font-black text-foreground uppercase tracking-tight">MARKET NOT FOUND</h1>
      <p className="text-muted text-sm font-bold uppercase tracking-widest">{reason}</p>
      <Link
        href="/"
        className="mt-4 bg-black text-background font-bold text-[11px] uppercase tracking-widest px-6 py-3 border border-black hover:bg-transparent hover:text-black transition-colors"
      >
        BACK TO FEED
      </Link>
    </main>
  );
}

function formatTime(s: number): string {
  if (s <= 0) return 'CLOSED';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}H ${m}M`;
  if (m > 0) return `${m}M ${sec}S`;
  return `${sec}S`;
}
