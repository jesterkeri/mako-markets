'use client';

import { useEffect, useState } from 'react';
import { formatEther } from 'viem';
import { type MarketWithId, MarketType } from '@/lib/contract';
import { poolSizeMon, secondsLeft, yesMultiplier, noMultiplier } from '@/lib/mocks';

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
 * `yesMultiplier` / `noMultiplier` from mocks.ts return 0 when the pool is
 * too thin (contract forces refund) — useful for disabling bet math, but
 * unhelpful on a card where the bettor deserves to see *something*.
 *
 * For display: if the pool meets the liquidity ratio, show the raw payout
 * multiplier. If it's thin enough that the contract will force a refund,
 * show `1.00x` — the bettor gets their stake back, which is what 1×
 * literally means.
 *
 * A side with zero stake has no multiplier at all (no one to pay it out).
 */
function displayMult(sidePool: bigint, raw: number): number {
  if (sidePool === 0n) return 0;
  // Non-zero pool, raw returned 0 → contract would refund → 1.00x payout.
  if (raw === 0) return 1.0;
  return raw;
}

function formatMon(wei: bigint): string {
  const n = Number(formatEther(wei));
  if (n === 0) return '0';
  if (n >= 100) return n.toFixed(0);
  if (n >= 10) return n.toFixed(1);
  return n.toFixed(2);
}

/**
 * Neobrutalist market tile. 2px ink border, 4×4 hard ink shadow, hover
 * lifts 1px up/left with a 6×6 shadow. YES uses ink fill with paper text;
 * NO uses mako-red with paper text. Footer carries per-side MON + bettor
 * counts and the total pool.
 */
export function MarketCard({ market }: { market: MarketWithId }) {
  const [timeLeft, setTimeLeft] = useState(() => secondsLeft(market));

  useEffect(() => {
    const id = setInterval(() => setTimeLeft(secondsLeft(market)), 1000);
    return () => clearInterval(id);
  }, [market]);

  const yesMult = displayMult(market.totalYes, yesMultiplier(market));
  const noMult = displayMult(market.totalNo, noMultiplier(market));
  const pool = poolSizeMon(market);
  const isClosed = timeLeft <= 0 || market.resolved;
  const yesMon = formatMon(market.totalYes);
  const noMon = formatMon(market.totalNo);

  // Closing-soon sticker appears under 1h; suppressed once the market closes
  // (the countdown chip already communicates that state).
  const showClosingSticker = !isClosed && timeLeft > 0 && timeLeft < 3600;
  // NEW sticker when the market was created within the last 10 minutes —
  // short enough that it's actually meaningful, not noise.
  const nowSec = Math.floor(Date.now() / 1000);
  const ageSec = nowSec - Number(market.createdAt);
  const showNewSticker = !isClosed && ageSec >= 0 && ageSec < 600;

  return (
    <div className="relative block w-full h-full bg-paper border-2 border-ink rounded-2xl shadow-[4px_4px_0_0_#000000] hover:shadow-[6px_6px_0_0_#000000] hover:-translate-y-1 transition-all group overflow-visible">
      {/* Corner stickers — tilted pills that pop off the card edge */}
      {showClosingSticker && (
        <div className="absolute -top-3 -right-2 z-10 bg-mako-red border-2 border-ink rounded-full px-3 py-1 shadow-[2px_2px_0_0_#000000] rotate-6">
          <span className="mako-label text-paper">CLOSING SOON</span>
        </div>
      )}
      {showNewSticker && !showClosingSticker && (
        <div className="absolute -top-3 -right-2 z-10 bg-signal border-2 border-ink rounded-full px-3 py-1 shadow-[2px_2px_0_0_#000000] -rotate-6">
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

        {/* Question */}
        <h3 className="mako-title text-xl mb-6 line-clamp-3 group-hover:underline underline-offset-4 decoration-2">
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
            {yesMon} MON · {market.yesBettorCount}{' '}
            {market.yesBettorCount === 1 ? 'BET' : 'BETS'}
          </div>
          <div className="mako-label text-[10px] text-muted tabular-nums text-right">
            {noMon} MON · {market.noBettorCount}{' '}
            {market.noBettorCount === 1 ? 'BET' : 'BETS'}
          </div>
        </div>

        {/* Footer strip — total pool + total bettors */}
        <div className="mt-3 pt-3 border-t-2 border-ink/10 flex justify-between items-center mako-label text-[10px] text-muted tabular-nums">
          <span>POOL · {pool.toFixed(2)} MON</span>
          <span>VOL · {market.yesBettorCount + market.noBettorCount} TOTAL</span>
        </div>
      </div>
    </div>
  );
}
