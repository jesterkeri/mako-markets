'use client';

import { useEffect, useState } from 'react';
import { type MarketWithId, MarketType } from '@/lib/contract';
import { poolSizeUsdc, secondsUntilBettingClose, yesMultiplier, noMultiplier } from '@/lib/mocks';
import { formatUsdc } from '@/lib/usdc';
import { useNowSec } from '@/lib/use-now';

function formatTimeLeft(s: number): string {
  if (s <= 0) return 'CLOSED';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

function categoryLabel(t: MarketType): string {
  if (t === MarketType.FOOTBALL) return 'FOOTBALL';
  if (t === MarketType.CRYPTO) return 'CRYPTO';
  if (t === MarketType.BASKETBALL) return 'NBA';
  return 'EVENT';
}

/**
 * Displayable multiplier for a side.
 *
 * `yesMultiplier` / `noMultiplier` return 0 in two cases under v4:
 *   - the side itself has no stake (no winners → no payout to display)
 *   - the OPPOSITE side has no stake (empty-side rule — contract's
 *     `previewPayout` returns the bettor's stake at 1×, market settles
 *     via REFUND outcome at resolution)
 *
 * For display we collapse the second case to `1.00x` because the bettor
 * gets their stake back, which is what 1× literally means. A side with
 * zero stake of its own has no displayable multiplier.
 */
function displayMult(sidePool: bigint, raw: number): number {
  if (sidePool === 0n) return 0;
  if (raw === 0) return 1.0;
  return raw;
}

/**
 * Neobrutalist market tile. 2px ink border, 4×4 hard ink shadow, hover
 * lifts 1px up/left with a 6×6 shadow. YES uses ink fill with paper text;
 * NO uses mako-red with paper text. Footer carries per-side USDC + bettor
 * counts and the total pool.
 *
 * **Time semantic:** the countdown chip reads `bettingCloseTime`, NOT
 * `closeTime`. v4 splits the two — bettingCloseTime is when placing bets
 * stops being legal, closeTime is when resolution becomes legal. For
 * sports they're hours apart; the bettor cares about the former.
 */
export function MarketCard({ market }: { market: MarketWithId }) {
  const [timeLeft, setTimeLeft] = useState(() => secondsUntilBettingClose(market));

  useEffect(() => {
    const id = setInterval(() => setTimeLeft(secondsUntilBettingClose(market)), 1000);
    return () => clearInterval(id);
  }, [market]);

  const yesMult = displayMult(market.totalYes, yesMultiplier(market));
  const noMult = displayMult(market.totalNo, noMultiplier(market));
  const pool = poolSizeUsdc(market);
  const isClosed = timeLeft <= 0 || market.resolved;
  const yesUsdc = formatUsdc(market.totalYes);
  const noUsdc = formatUsdc(market.totalNo);

  // Closing-soon sticker appears under 1h; suppressed once the market closes
  // (the countdown chip already communicates that state).
  const showClosingSticker = !isClosed && timeLeft > 0 && timeLeft < 3600;
  // NEW sticker when the market was created within the last 10 minutes —
  // short enough that it's actually meaningful, not noise. `useNowSec`
  // satisfies React's purity rule by storing now in state and ticking it.
  const nowSec = useNowSec();
  const ageSec = nowSec - Number(market.createdAt);
  const showNewSticker = !isClosed && ageSec >= 0 && ageSec < 600;

  return (
    <div className="relative block w-full h-full bg-paper border-2 border-ink rounded-2xl shadow-brutal hover:shadow-brutal-lg hover:-translate-y-1 transition-all group overflow-visible">
      {/* Corner stickers — tilted pills that pop off the card edge */}
      {showClosingSticker && (
        <div className="absolute -top-3 -right-2 z-10 bg-mako-red border-2 border-ink rounded-full px-3 py-1 shadow-brutal-sm rotate-6">
          <span className="mako-label text-paper">CLOSING SOON</span>
        </div>
      )}
      {showNewSticker && !showClosingSticker && (
        <div className="absolute -top-3 -right-2 z-10 bg-signal border-2 border-ink rounded-full px-3 py-1 shadow-brutal-sm -rotate-6">
          <span className="mako-label text-ink">NEW</span>
        </div>
      )}

      <div className="p-5 flex flex-col h-full bg-surface-elevated min-h-[260px] rounded-2xl overflow-hidden">
        {/* Header: category + countdown */}
        <div className="flex justify-between items-start mb-3">
          <span className="mako-label text-muted">{categoryLabel(market.mType)}</span>
          <span className={`mako-label ${isClosed ? 'text-muted' : 'text-mako-red'}`}>
            {formatTimeLeft(timeLeft)}
          </span>
        </div>

        {/* Question. Fluid title: 16px min (cramped 3-up cards),
            20px max (widest 1-up). The previous `text-xl` (20px)
            forced word-by-word truncation on narrow columns. */}
        <h3 className="mako-title text-[clamp(1.25rem,1.4vw,1.5rem)] mb-6 line-clamp-3 group-hover:underline underline-offset-4 decoration-2">
          {market.question}
        </h3>

        {/* YES / NO tiles — multiplier only */}
        <div className="mt-auto grid grid-cols-2 gap-3">
          <div className="bg-ink text-paper py-3 px-4 border-2 border-ink rounded-lg">
            <div className="mako-label text-paper/80">YES</div>
            <div className="mako-display text-3xl tabular-nums mt-1.5">
              {yesMult > 0 ? `${yesMult.toFixed(2)}x` : '—'}
            </div>
          </div>
          <div className="bg-mako-red text-paper py-3 px-4 border-2 border-ink rounded-lg">
            <div className="mako-label text-paper/80">NO</div>
            <div className="mako-display text-3xl tabular-nums mt-1.5">
              {noMult > 0 ? `${noMult.toFixed(2)}x` : '—'}
            </div>
          </div>
        </div>

        {/* Per-side stake + bettor breakdown */}
        <div className="grid grid-cols-2 gap-3 mt-3">
          <div className="mako-label text-[10px] text-muted tabular-nums">
            {yesUsdc} USDC · {market.yesBettorCount}{' '}
            {market.yesBettorCount === 1 ? 'BET' : 'BETS'}
          </div>
          <div className="mako-label text-[10px] text-muted tabular-nums text-right">
            {noUsdc} USDC · {market.noBettorCount}{' '}
            {market.noBettorCount === 1 ? 'BET' : 'BETS'}
          </div>
        </div>

        {/* Footer strip — total pool + total bettors */}
        <div className="mt-3 pt-3 border-t-2 border-ink/10 flex justify-between items-center mako-label text-[10px] text-muted tabular-nums">
          <span>POOL · {pool.toFixed(2)} USDC</span>
          <span>VOL · {market.yesBettorCount + market.noBettorCount} TOTAL</span>
        </div>
      </div>
    </div>
  );
}
