'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useAccount, useWaitForTransactionReceipt } from 'wagmi';
import { useMarket, useResolveMarket } from '@/lib/hooks';
import { useUser } from '@/lib/use-user';
import { MarketType, Outcome, marketTypeLabel, type MarketWithId } from '@/lib/contract';
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
import { CommentsSection } from '@/components/CommentsSection';
import { MarketChart } from '@/components/MarketChart';
import { marketToChartConfig } from '@/lib/market-chart';
import { useMakoLabels } from '@/lib/use-mako-labels';
import { outcomeLabelForMarket } from '@/components/admin-shared';
import { ShareMarketButton } from '@/components/ShareMarketButton';
import { BroadcastButton } from '@/components/BroadcastButton';
import { formatTime, humanizeUntil } from '@/lib/time';
import { ThemeToggle } from '@/components/ThemeToggle';
import { MobileChromeHeader } from '@/components/MobileChromeHeader';
import { AuthMenu } from '@/components/AuthMenu';
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

  const { address, isConnecting, isReconnecting } = useAccount();
  const { user, isLoading: userLoading } = useUser();
  const isUnauthed = !user && !address && !userLoading && !isConnecting && !isReconnecting;

  const [betSide, setBetSide] = useState<'yes' | 'no'>('yes');

  /// MAKO label lookup — null for non-MAKO markets (hook stays
  /// disabled, no fetch). Header chips (YES X% / X% NO), the embedded
  /// admin resolve buttons (RESOLVE YES / RESOLVE NO), and any other
  /// outcome rendering on this page route through
  /// `outcomeLabelForMarket` which delegates to "YES" / "NO" when
  /// labels are null. The hook resolves once per market and is shared
  /// across render branches because it's at the top of the component.
  const { data: makoLabels } = useMakoLabels(
    market?.mType === MarketType.MAKO && parsedId !== null
      ? parsedId.toString()
      : null,
  );
  const yesSideLabel = market
    ? outcomeLabelForMarket(market, makoLabels ?? null, 1)
    : 'YES';
  const noSideLabel = market
    ? outcomeLabelForMarket(market, makoLabels ?? null, 2)
    : 'NO';

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

  const isYesEmpty = market?.totalYes === 0n;
  const isNoEmpty = market?.totalNo === 0n;

  const badgeText = marketTypeLabel(market.mType);

  const statusLabel = market.resolved
    ? `RESOLVED: ${Outcome[market.outcome]}`
    : bettingTimeLeft > 0
      ? formatTime(bettingTimeLeft)
      : 'AWAITING RESOLUTION';

  const totalYesNum = Number(formatUsdc(market.totalYes));
  const totalNoNum = Number(formatUsdc(market.totalNo));
  const totalPoolNum = totalYesNum + totalNoNum;

  const yesProb = totalPoolNum > 0 ? (totalYesNum / totalPoolNum) * 100 : 50;
  const noProb = totalPoolNum > 0 ? (totalNoNum / totalPoolNum) * 100 : 50;

  return (
    <main className="flex-1 w-full pb-[var(--page-safe-pb)] lg:pb-12 max-w-[1400px] mx-auto flex flex-col">
      <MobileChromeHeader />

      <header className="hidden md:flex items-center justify-between px-6 lg:px-8 h-12 border-b-2 border-chrome-divider bg-chrome text-chrome-fg sticky top-0 z-30">
        <div className="flex items-center gap-4">
          <Link 
            href="/" 
            className="flex items-center gap-2 px-3 py-1 rounded-full border-2 border-chrome-divider hover:border-chrome-fg hover:bg-chrome-fg hover:text-chrome transition-colors text-chrome-fg mako-label text-[10px] tracking-widest"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="square" strokeLinejoin="miter">
              <path d="M19 12H5M12 19l-7-7 7-7"/>
            </svg>
            FEED
          </Link>
          <span className="mako-label text-chrome-fg/50 hidden sm:inline-block">
            MARKET #{market.id.toString()}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <AuthMenu className="px-3! py-1.5! text-[11px]!" />
          <ThemeToggle />
          <Link
            href="/create"
            className="mako-button mako-button--signal mako-label px-3! py-1.5! text-[11px]!"
          >
            + NEW MARKET
          </Link>
        </div>
      </header>

      <div className="px-4 sm:px-6 lg:px-8 py-10 md:py-16 flex flex-col md:flex-row gap-8 lg:gap-16 items-start">
        <div className="flex-1 w-full min-w-[320px] max-w-4xl flex flex-col gap-10">
          {/* Floating Massive Question */}
          {/* Fluid title typography. clamp(min, fluid, max) — 36px at
              the narrowest phone, scales with viewport up to a 72px cap
              on wide desktop. The previous breakpoint ladder locked at
              80px on md+, which dominated wide screens (the question
              text would eat half the viewport). */}
          <h1 className="mako-display text-[clamp(2.25rem,5.5vw,4.5rem)] leading-[0.95] tracking-tighter text-canvas-fg">
            {market.question}
          </h1>

          {/* Price chart — top placement, immediately under the
              question. Only rendered for CRYPTO / FOREX / COMMODITIES /
              STOCKS markets whose oracleRef symbol is in the chart
              allowlist. Sports / MAKO / MON markets return null and
              the slot disappears entirely. */}
          {(() => {
            const chartConfig = marketToChartConfig(market);
            if (!chartConfig) return null;
            return (
              <section className="min-w-0" aria-label="Price chart">
                <MarketChart
                  oracleSymbol={chartConfig.oracleSymbol}
                  assetClass={chartConfig.assetClass}
                />
              </section>
            );
          })()}

          {/* Tug of War Probability Bar */}
          <div className="flex flex-col gap-3">
            <div className="flex justify-between items-end px-2">
              <span className={`mako-display text-[clamp(1.875rem,3vw,2.25rem)] transition-all duration-300 ${betSide === 'yes' ? 'text-signal scale-105 origin-bottom-left' : 'text-muted'}`}>{yesSideLabel} {yesProb.toFixed(0)}%</span>
              <span className={`mako-display text-[clamp(1.875rem,3vw,2.25rem)] transition-all duration-300 ${betSide === 'no' ? 'text-mako-red scale-105 origin-bottom-right' : 'text-muted'}`}>{noProb.toFixed(0)}% {noSideLabel}</span>
            </div>
            
            <div className="w-full h-20 md:h-24 flex rounded-full border-4 border-ink overflow-hidden shadow-[8px_8px_0_0_var(--mako-ink)] relative bg-paper cursor-pointer group" onClick={(e) => {
              if (bettingClosed) return;
              const rect = e.currentTarget.getBoundingClientRect();
              const x = e.clientX - rect.left;
              setBetSide(x < rect.width / 2 ? 'yes' : 'no');
            }}>
              {/* YES Fill */}
              <div 
                className={`h-full bg-signal transition-all duration-500 ease-out flex items-center justify-start px-6 ${betSide === 'yes' && !bettingClosed ? 'brightness-110' : ''}`}
                style={{ width: `${Math.max(15, Math.min(85, yesProb))}%` }}
              >
                {betSide === 'yes' && !bettingClosed && <div className="w-4 h-4 bg-ink rounded-full animate-pulse" />}
              </div>
              {/* NO Fill (Remaining) */}
              <div className={`flex-1 h-full bg-mako-red border-l-4 border-ink flex items-center justify-end px-6 transition-all duration-500 ease-out ${betSide === 'no' && !bettingClosed ? 'brightness-110' : ''}`}>
                {betSide === 'no' && !bettingClosed && <div className="w-4 h-4 bg-paper rounded-full animate-pulse" />}
              </div>
            </div>
            
            <div className="flex justify-between px-4 text-muted mako-mono text-xs">
              <span>{formatUsdc(market.totalYes)} USDC STAKED</span>
              <span>{formatUsdc(market.totalNo)} USDC STAKED</span>
            </div>
          </div>

          {/* Floating Stats Row */}
          <div className="flex flex-wrap gap-4 items-center mt-4">
            <div className="bg-paper border-2 border-ink rounded-xl px-5 py-3 shadow-[4px_4px_0_0_var(--mako-ink)] mako-tilt-left">
              <span className="mako-label text-muted block text-[10px]">TOTAL POOL</span>
              <span className="mako-display text-[clamp(1.5rem,2vw,1.75rem)]">{poolSize.toFixed(2)} USDC</span>
            </div>
            <div className="bg-paper border-2 border-ink rounded-xl px-5 py-3 shadow-[4px_4px_0_0_var(--mako-ink)] mako-tilt-right">
              <span className="mako-label text-muted block text-[10px]">BETTORS</span>
              <span className="mako-display text-[clamp(1.5rem,2vw,1.75rem)]">{totalBettors}</span>
            </div>
            <div className="ml-auto mako-mono text-[10px] text-muted flex flex-col items-end">
              <span>Created by {market.creator.slice(0, 6)}...{market.creator.slice(-4)}</span>
              <span>ID: #{market.id.toString()}</span>
            </div>
          </div>

          {/* Action Tools */}
          <div className="flex flex-wrap gap-3 mt-4">
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

          {/* Awaiting resolution banner */}
          {awaitingResolution && (
            <div className="mt-8">
              <AwaitingResolutionPanel
                market={market}
                onResolved={refetch}
                yesSideLabel={yesSideLabel}
                noSideLabel={noSideLabel}
              />
            </div>
          )}

          {/* #182 Comments — full-width in the left column, below the market
              content, so it never collides with the sticky BetSheet column. */}
          <div className="mt-10">
            <CommentsSection scope="main" marketId={market.id.toString()} />
          </div>
        </div>

        {/* Right Sidebar for Desktop / Fixed bottom for Mobile */}
        {(market.resolved || !bettingClosed) && (
          <div className="w-full md:w-[280px] lg:w-[400px] shrink-0 md:sticky md:top-8 z-40 mt-4 md:mt-0">
            {/* Mobile fixed-bottom wrapper.
                `bottom-10` lifts the sheet 40px above viewport bottom.
                At `md+` (tablets/foldables), `md:static` joins normal flow
                as the right column, moving side-by-side. */}
            <div className="fixed bottom-10 left-0 right-0 z-50 md:static md:left-auto md:right-auto md:bottom-auto shadow-[0_-12px_40px_rgba(0,0,0,0.15)] md:shadow-none">
              {market.resolved ? (
                <div className="p-4 bg-paper md:p-0 md:bg-transparent border-t-2 border-ink md:border-0">
                  <ClaimButton market={market} onSuccess={refetch} />
                </div>
              ) : !bettingClosed ? (
                isUnauthed ? (
                  <div className="bg-paper border-t-2 md:border-2 border-ink md:rounded-[24px] md:shadow-[8px_8px_0_0_var(--mako-ink)] overflow-hidden w-full mx-auto max-w-md md:max-w-none flex flex-col items-center justify-center p-8 pb-safe md:pb-8 text-center">
                    <h2 className="mako-display text-3xl mb-3">READY TO BET?</h2>
                    <p className="mako-body text-muted mb-8 text-[15px]">Sign in or connect a wallet to place your position.</p>
                    <Link
                      href="/signup"
                      className="flex items-center justify-center w-full py-5 text-center bg-signal text-ink mako-display text-xl uppercase tracking-tight hover:translate-x-[2px] hover:translate-y-[2px] border-2 border-ink rounded-xl shadow-[4px_4px_0_0_var(--mako-ink)] hover:shadow-[2px_2px_0_0_var(--mako-ink)] active:translate-x-[4px] active:translate-y-[4px] active:shadow-none transition-all"
                    >
                      SIGN IN TO BET
                    </Link>
                  </div>
                ) : (
                  <BetSheet market={market} side={betSide} onSuccess={refetch} />
                )
              ) : null}
            </div>
          </div>
        )}
      </div>
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
  yesSideLabel,
  noSideLabel,
}: {
  market: MarketWithId;
  onResolved: () => void;
  /// Pre-resolved outcome labels from the parent. Threaded as props
  /// rather than re-calling `useMakoLabels` here so the page issues
  /// one fetch per market detail render, not two.
  yesSideLabel: string;
  noSideLabel: string;
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
    // Headline per market type: sports get event-specific copy, price-feed
    // types share the CRYPTO copy (FOREX / COMMODITIES / STOCKS resolve via
    // the same oracle pattern), MAKO is the admin-curated path.
    const headline =
      market.mType === MarketType.FOOTBALL
        ? 'BET LIVE · RESOLVES AFTER FULL TIME'
        : market.mType === MarketType.BASKETBALL
          ? 'BET LIVE · RESOLVES AFTER FINAL BUZZER'
          : market.mType === MarketType.CRYPTO
            || market.mType === MarketType.FOREX
            || market.mType === MarketType.COMMODITIES
            || market.mType === MarketType.STOCKS
            ? 'WINDOW CLOSED · RESOLVING NOW'
            : market.mType === MarketType.MAKO
              ? 'AWAITING MAKO RESOLUTION'
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
          RESOLVE {yesSideLabel}
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => handleResolve(Outcome.NO)}
          className="py-4 mako-label border-r-2 border-ink bg-paper hover:bg-mako-red hover:text-paper transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          RESOLVE {noSideLabel}
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
