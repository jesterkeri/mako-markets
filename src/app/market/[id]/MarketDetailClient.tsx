'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useWaitForTransactionReceipt } from 'wagmi';
import { useMarket, useResolveMarket } from '@/lib/hooks';
import { MarketType, Outcome, type MarketWithId } from '@/lib/contract';
import { useIsAdmin } from '@/lib/admin';
import {
  yesMultiplier,
  noMultiplier,
  secondsLeft,
  secondsUntilBettingClose,
  poolSizeUsdc,
} from '@/lib/mocks';
import { formatUsdc } from '@/lib/usdc';
import { BetSheet } from '@/components/BetSheet';
import { ClaimButton } from '@/components/ClaimButton';
import { ShareMarketButton } from '@/components/ShareMarketButton';
import { BroadcastButton } from '@/components/BroadcastButton';
import { formatTime, humanizeUntil } from '@/lib/time';

/**
 * Interactive client half of the market detail page. The parent server
 * page.tsx owns metadata (og:title / og:image) + awaits the dynamic route
 * params; we just receive the stringified id and render the wagmi-driven UI.
 *
 * **v4 timestamp split** — `bettingClosed` (the bet-button gate) reads
 * `bettingCloseTime`. The "AWAITING RESOLUTION" banner reads `closeTime`
 * (resolution legality). For sports, the two sit hours apart.
 */
export function MarketDetailClient({ id }: { id: string }) {
  let parsedId: bigint | null = null;
  try {
    parsedId = BigInt(id);
  } catch {
    /* keep null, handled below */
  }

  const { market, isLoading, refetch } = useMarket(parsedId ?? 0n);

  const [betSide, setBetSide] = useState<'yes' | 'no'>('yes');

  if (parsedId === null) {
    return <NotFound reason={`Invalid market id: ${id}`} />;
  }

  if (isLoading && !market) {
    return (
      <main className="flex-1 flex flex-col px-4 sm:px-6 lg:px-8 py-6 md:py-10">
        <div className="max-w-3xl mx-auto w-full">
          <div className="mako-skeleton h-10 w-40 mb-6" aria-hidden />
          <div className="mako-skeleton h-40 mb-6" aria-hidden />
          <div className="grid grid-cols-2 gap-5">
            <div className="mako-skeleton h-32" aria-hidden />
            <div className="mako-skeleton h-32" aria-hidden />
          </div>
        </div>
      </main>
    );
  }

  if (!market) {
    return <NotFound reason={`Market #${id} not found on-chain.`} />;
  }

  const poolSize = poolSizeUsdc(market);
  const yesMult = yesMultiplier(market);
  const noMult = noMultiplier(market);
  const bettingTimeLeft = secondsUntilBettingClose(market);
  const resolutionTimeLeft = secondsLeft(market);
  const totalBettors = market.yesBettorCount + market.noBettorCount;
  const isWarning = bettingTimeLeft > 0 && bettingTimeLeft <= 15;
  const bettingClosed = bettingTimeLeft <= 0 || market.resolved;
  // Resolution legality is gated on closeTime, NOT bettingCloseTime —
  // the AwaitingResolutionPanel only appears once the contract would
  // accept a resolveMarket call.
  const awaitingResolution = !market.resolved && resolutionTimeLeft <= 0;

  const badgeText =
    market.mType === MarketType.FOOTBALL ? 'FOOTBALL'
    : market.mType === MarketType.CRYPTO ? 'CRYPTO'
    : market.mType === MarketType.BASKETBALL ? 'NBA'
    : 'EVENT';

  const statusLabel = market.resolved
    ? `RESOLVED: ${Outcome[market.outcome]}`
    : bettingTimeLeft > 0
      ? formatTime(bettingTimeLeft)
      : 'AWAITING RESOLUTION';

  return (
    <main className="flex-1 flex flex-col w-full pb-48">
      <div className="px-4 sm:px-6 lg:px-8 py-6 md:py-10 max-w-3xl mx-auto w-full">
        {/* Category + countdown sticker row */}
        <div className="flex items-center justify-between mb-5">
          <span className="mako-label text-muted">{badgeText}</span>
          <span
            className={`mako-label ${
              isWarning ? 'text-mako-red' : bettingClosed ? 'text-muted' : 'text-mako-red'
            }`}
          >
            {statusLabel}
          </span>
        </div>

        {/* Question card */}
        <div className="bg-paper border-2 border-ink rounded-2xl shadow-brutal p-6 md:p-8 mb-6">
          <h1 className="mako-display text-3xl md:text-5xl leading-[1.05]">
            {market.question}
          </h1>
        </div>

        {/* YES / NO side picker — tap either to switch BetSheet side */}
        <div className="grid grid-cols-2 gap-4 mb-6">
          <button
            type="button"
            onClick={() => setBetSide('yes')}
            disabled={bettingClosed}
            aria-pressed={betSide === 'yes'}
            className={`p-5 border-2 border-ink rounded-2xl transition-all text-left disabled:opacity-50 disabled:cursor-not-allowed ${
              betSide === 'yes'
                ? 'bg-ink text-paper shadow-[4px_4px_0_0_#D94A3D] -translate-y-[2px] -translate-x-[2px]'
                : 'bg-paper text-ink shadow-brutal hover:-translate-y-[1px] hover:-translate-x-[1px]'
            }`}
          >
            <div className={`mako-label ${betSide === 'yes' ? 'text-paper/80' : 'text-muted'}`}>
              YES
            </div>
            <div className="mako-display text-3xl md:text-4xl tabular-nums mt-2">
              {yesMult > 0 ? `${yesMult.toFixed(2)}x` : '—'}
            </div>
            <div className={`mako-mono text-[11px] mt-2 tabular-nums ${betSide === 'yes' ? 'text-paper/60' : 'text-muted'}`}>
              {formatUsdc(market.totalYes)} USDC
            </div>
          </button>

          <button
            type="button"
            onClick={() => setBetSide('no')}
            disabled={bettingClosed}
            aria-pressed={betSide === 'no'}
            className={`p-5 border-2 border-ink rounded-2xl transition-all text-left disabled:opacity-50 disabled:cursor-not-allowed ${
              betSide === 'no'
                ? 'bg-mako-red text-paper shadow-brutal -translate-y-[2px] -translate-x-[2px]'
                : 'bg-paper text-ink shadow-brutal hover:-translate-y-[1px] hover:-translate-x-[1px]'
            }`}
          >
            <div className={`mako-label ${betSide === 'no' ? 'text-paper/80' : 'text-muted'}`}>
              NO
            </div>
            <div className="mako-display text-3xl md:text-4xl tabular-nums mt-2">
              {noMult > 0 ? `${noMult.toFixed(2)}x` : '—'}
            </div>
            <div className={`mako-mono text-[11px] mt-2 tabular-nums ${betSide === 'no' ? 'text-paper/60' : 'text-muted'}`}>
              {formatUsdc(market.totalNo)} USDC
            </div>
          </button>
        </div>

        {/* Metrics grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          <div className="mako-metric">
            <div className="mako-metric__label">POOL</div>
            <div className="mako-metric__value tabular-nums">{poolSize.toFixed(2)}</div>
            <div className="mako-metric__sub text-muted">USDC</div>
          </div>
          <div className="mako-metric">
            <div className="mako-metric__label">BETTORS</div>
            <div className="mako-metric__value tabular-nums">{totalBettors}</div>
          </div>
          <div className="mako-metric">
            <div className="mako-metric__label">YES</div>
            <div className="mako-metric__value tabular-nums">{market.yesBettorCount}</div>
          </div>
          <div className="mako-metric">
            <div className="mako-metric__label">NO</div>
            <div className="mako-metric__value tabular-nums">{market.noBettorCount}</div>
          </div>
        </div>

        {/* Action row — share / broadcast / new market */}
        <div className="flex flex-wrap gap-3 mb-6">
          <ShareMarketButton marketId={market.id} />
          <BroadcastButton
            marketId={market.id}
            question={market.question}
            bettingCloseTimeSec={market.bettingCloseTime}
          />
          <Link href="/create" className="mako-button mako-label">
            NEW MARKET
          </Link>
        </div>

        {/* Creator address */}
        <div className="mako-mono text-[11px] text-muted break-all mb-4">
          Created by {market.creator}
        </div>

        {/* Awaiting resolution banner + admin inline resolve */}
        {awaitingResolution && (
          <AwaitingResolutionPanel market={market} onResolved={refetch} />
        )}
      </div>

      {/* Fixed-bottom action UI */}
      {market.resolved ? (
        <ClaimButton market={market} onSuccess={refetch} />
      ) : !bettingClosed ? (
        <BetSheet market={market} side={betSide} onSuccess={refetch} />
      ) : null}
    </main>
  );
}

/**
 * Inline "awaiting resolution" panel. Non-admins see a passive warning.
 * Admins get three one-tap resolve buttons.
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

  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 60_000);
    return () => clearInterval(id);
  }, []);

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

  if (!isAdmin) {
    const headline =
      market.mType === MarketType.FOOTBALL
        ? 'BET LIVE · RESOLVES AFTER FULL TIME'
        : market.mType === MarketType.BASKETBALL
          ? 'BET LIVE · RESOLVES AFTER FINAL BUZZER'
          : market.mType === MarketType.CRYPTO
            ? 'WINDOW CLOSED · RESOLVING NOW'
            : 'MARKET CLOSED · RESOLVING';
    const closedAgoLabel = humanizeUntil(Number(market.closeTime) - nowSec);
    return (
      <div className="bg-mako-red/10 border-2 border-mako-red rounded-2xl p-5 text-center">
        <div className="mako-label text-mako-red mb-2">AWAITING RESOLUTION</div>
        <div className="mako-title text-lg mb-1">{headline}</div>
        <div className="mako-body text-[12px] text-muted">
          Closed {closedAgoLabel} · resolver polling every 30s
        </div>
      </div>
    );
  }

  return (
    <div className="bg-signal border-2 border-ink rounded-2xl shadow-brutal overflow-hidden">
      <div className="px-5 py-4 text-center">
        <div className="mako-label mb-1">ADMIN · PICK OUTCOME</div>
        <div className="mako-body text-[12px] text-ink/80">
          One tap to resolve. Contract refunds on one-sided pools.
        </div>
      </div>
      <div className="grid grid-cols-3 border-t-2 border-ink">
        <button
          type="button"
          disabled={disabled}
          onClick={() => handleResolve(Outcome.YES)}
          className="py-4 mako-label border-r-2 border-ink bg-paper hover:bg-ink hover:text-paper transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          RESOLVE YES
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => handleResolve(Outcome.NO)}
          className="py-4 mako-label border-r-2 border-ink bg-paper hover:bg-mako-red hover:text-paper transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          RESOLVE NO
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => handleResolve(Outcome.REFUND)}
          className="py-4 mako-label bg-paper hover:bg-ink hover:text-paper transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          REFUND
        </button>
      </div>
      {statusText && (
        <div
          className={`px-5 py-2 mako-label text-center border-t-2 border-ink break-words ${
            isSuccess ? 'bg-signal text-ink' : error ? 'bg-mako-red/15 text-mako-red' : 'text-muted bg-paper'
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
    <main className="flex-1 flex flex-col items-center justify-center gap-6 py-20 px-6 text-center">
      <div className="-rotate-2">
        <div className="bg-paper border-2 border-ink rounded-2xl shadow-brutal p-8">
          <h1 className="mako-display text-3xl mb-3">MARKET NOT FOUND</h1>
          <p className="mako-body text-muted">{reason}</p>
        </div>
      </div>
      <Link href="/" className="mako-button mako-button--signal mako-label">
        BACK TO FEED
      </Link>
    </main>
  );
}
