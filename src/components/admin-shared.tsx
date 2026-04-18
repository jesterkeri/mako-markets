'use client';

import Link from 'next/link';
import { ADMIN_ADDRESS } from '@/lib/admin';
import { humanizeUntil } from '@/lib/time';
import { useNowSec } from '@/lib/use-now';
import { monadTestnet } from '@/lib/chain';
import type { AdminAnalytics } from '@/lib/admin-analytics';

/**
 * Shared bits every /admin/* page reuses: back bar, not-authorized panel,
 * activity row renderer, and a few formatter helpers.
 *
 * Kept in one file so the pages stay thin and the visual grammar stays
 * identical across all admin screens.
 */

export function TopBar() {
  return (
    <div className="px-6 md:px-8 py-4 border-b border-black">
      <Link
        href="/"
        className="text-foreground text-sm font-black uppercase tracking-widest hover:bg-black hover:text-background px-2 py-1 -ml-2 inline-block transition-colors"
      >
        &lt; BACK
      </Link>
    </div>
  );
}

export function NotAuthorized() {
  return (
    <main className="flex-1 flex flex-col items-center justify-center gap-4 py-16 px-6 text-center">
      <h1 className="text-3xl font-black uppercase tracking-tight">NOT AUTHORIZED</h1>
      <p className="text-muted text-xs font-bold uppercase tracking-widest">
        CONNECT THE ADMIN WALLET TO VIEW THIS PAGE
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

export function fourDp(decimalStr: string): string {
  const n = Number(decimalStr);
  if (!Number.isFinite(n)) return decimalStr;
  return n.toFixed(4);
}

export function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function outcomeLabel(o: 0 | 1 | 2 | 3): string {
  return o === 1 ? 'YES' : o === 2 ? 'NO' : o === 3 ? 'REFUND' : '—';
}

export function typeLabel(m: 0 | 1 | 2): string {
  return m === 0 ? 'FOOTBALL' : m === 1 ? 'CRYPTO' : 'BASKETBALL';
}

export function explorerAddress(addr: string): string {
  return `${monadTestnet.blockExplorers.default.url}address/${addr}`;
}

export function explorerTx(hash: string): string {
  return `${monadTestnet.blockExplorers.default.url}tx/${hash}`;
}

/**
 * Banner shown at the top of any admin page when the server reports
 * that one or more event log streams failed during aggregation. Every
 * admin page should render this — without it, silently-wrong totals
 * look identical to correct ones.
 */
export function DegradedBanner({ streams }: { streams: string[] }) {
  if (streams.length === 0) return null;
  return (
    <div className="bg-warning/15 border-b border-warning px-6 md:px-8 py-3 text-[10px] font-black uppercase tracking-widest text-warning">
      DEGRADED · MISSING {streams.map((s) => s.toUpperCase()).join(' · ')} STREAM{streams.length > 1 ? 'S' : ''} · TOTALS MAY UNDERCOUNT
    </div>
  );
}

type Activity = AdminAnalytics['activity'][number];

export function ActivityRow({ activity: a }: { activity: Activity }) {
  const nowSec = useNowSec();
  const ago = a.tsSec ? humanizeUntil(a.tsSec - nowSec) : '—';

  let kindLabel = '';
  let sentence = '';
  switch (a.kind) {
    case 'bet':
      kindLabel = 'BET';
      sentence = `${short(a.user)} BET ${fourDp(a.amountMon)} MON ${a.isYes ? 'YES' : 'NO'} ON #${a.marketId}`;
      break;
    case 'market':
      kindLabel = 'MARKET';
      sentence = `${short(a.user)} CREATED MARKET #${a.marketId}`;
      break;
    case 'resolve':
      kindLabel = 'RESOLVE';
      sentence = `#${a.marketId} RESOLVED → ${outcomeLabel(a.outcome)}`;
      break;
    case 'claim':
      kindLabel = 'CLAIM';
      sentence = `${short(a.user)} CLAIMED ${fourDp(a.amountMon)} MON ON #${a.marketId}`;
      break;
    case 'fee':
      kindLabel = 'FEE';
      sentence = `${short(a.user)} CLAIMED ${fourDp(a.amountMon)} MON CREATOR FEE ON #${a.marketId}`;
      break;
  }

  return (
    <div className="border-b border-black px-6 md:px-8 py-3 flex items-center gap-4 text-[11px] font-black uppercase tracking-widest">
      <span className="text-muted w-16 shrink-0">{kindLabel}</span>
      <span className="flex-1 min-w-0 truncate">{sentence}</span>
      <a
        href={explorerTx(a.txHash)}
        target="_blank"
        rel="noreferrer noopener"
        className="text-subtle hover:text-foreground shrink-0 tabular-nums"
      >
        {ago}
      </a>
    </div>
  );
}
