'use client';

import { useEffect, useMemo, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { humanizeUntil } from '@/lib/time';

/**
 * Fullscreen broadcast modal. Shows a market's question, a large QR code
 * pointing at its detail URL, and a live countdown to close. Built for the
 * in-room / stream overlay use case — scan, bet, repeat.
 *
 * Non-negotiables this component enforces (per plan):
 *  - QR URL is computed at open time from window.location.origin (or
 *    NEXT_PUBLIC_APP_URL if set). SSR-time localhost will never leak.
 *  - Body scroll is locked while open, restored to the EXACT prior value
 *    on close (no hardcoded ''). Double-open/close cycles don't leak.
 *  - ESC key closes; listener is registered in the same effect as the
 *    scroll lock and removed in cleanup — no orphaned listeners on
 *    unmount / re-render.
 *  - role="dialog" + aria-modal + aria-labelledby for screen readers.
 */
export function BroadcastQrModal({
  open,
  onClose,
  marketId,
  question,
  bettingCloseTimeSec,
}: {
  open: boolean;
  onClose: () => void;
  marketId: bigint;
  question: string;
  /**
   * v4 betting cutoff. The QR overlay countdown lives here because the
   * "scan and bet" flow only makes sense while bets are still legal —
   * `closeTime` (resolution legality) sits hours later for sports.
   */
  bettingCloseTimeSec: bigint;
}) {
  // Live countdown state — re-renders every second so the viewer watches
  // the clock tick down. Only runs while `open` is true.
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));

  // Resolve URL at open time. Prefer the env override so Vercel canary
  // URLs / local dev never get baked into a real broadcast QR.
  const shareUrl = useMemo(() => {
    if (!open || typeof window === 'undefined') return '';
    const envOrigin = process.env.NEXT_PUBLIC_APP_URL;
    const origin = envOrigin && envOrigin.length > 0 ? envOrigin : window.location.origin;
    return `${origin.replace(/\/$/, '')}/market/${marketId.toString()}`;
  }, [open, marketId]);

  // Tick the clock + manage body scroll lock + ESC listener, all in one
  // effect so cleanup is atomic. Symmetric: captures the prior overflow
  // value on open, restores it verbatim on close.
  useEffect(() => {
    if (!open) return;

    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);

    const tickId = setInterval(() => {
      setNowSec(Math.floor(Date.now() / 1000));
    }, 1_000);

    return () => {
      document.body.style.overflow = priorOverflow;
      document.removeEventListener('keydown', onKey);
      clearInterval(tickId);
    };
  }, [open, onClose]);

  if (!open) return null;

  const bettingCloseTimeNum = Number(bettingCloseTimeSec);
  const delta = bettingCloseTimeNum - nowSec;
  const countdownLabel =
    delta > 0 ? `CLOSES ${humanizeUntil(delta).toUpperCase()}` : 'CLOSED — RESOLVING';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="broadcast-question"
      // Full-screen fixed overlay, opaque background so the QR pops at
      // distance. Click backdrop to close.
      className="fixed inset-0 z-[100] bg-[var(--color-background)] flex flex-col items-center justify-center px-6 py-10"
      onClick={onClose}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="absolute top-5 right-5 font-black text-xs uppercase tracking-widest px-4 py-2 border border-black hover:bg-black hover:text-background transition-colors"
        aria-label="Close broadcast"
      >
        [ CLOSE · ESC ]
      </button>

      <h2
        id="broadcast-question"
        className="font-black uppercase tracking-tight leading-none text-center max-w-5xl text-5xl md:text-7xl mb-10"
        onClick={(e) => e.stopPropagation()}
      >
        {question}
      </h2>

      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-[var(--color-background)] p-6 border-4 border-black"
      >
        <QRCodeSVG
          value={shareUrl}
          size={400}
          bgColor="#EBE5D9"
          fgColor="#000000"
          level="M"
        />
      </div>

      <div
        onClick={(e) => e.stopPropagation()}
        className="mt-10 font-black uppercase tracking-widest text-xl md:text-2xl tabular-nums"
      >
        {countdownLabel}
      </div>

      <div className="mt-3 text-[10px] font-black uppercase tracking-widest text-muted max-w-md text-center break-all">
        {shareUrl}
      </div>
    </div>
  );
}
