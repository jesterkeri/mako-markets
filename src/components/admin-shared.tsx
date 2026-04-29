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
  // Back link removed — sidebar navigation already lets users jump anywhere.
  // Kept as a no-op so every existing /admin/* import keeps working.
  return null;
}

export function NotAuthorized() {
  return (
    <main className="flex-1 flex flex-col items-center justify-center gap-6 py-20 px-6 text-center">
      <div className="-rotate-2">
        <div className="bg-paper border-2 border-ink rounded-2xl shadow-[4px_4px_0_0_#000000] p-8 max-w-sm">
          <h1 className="mako-display text-3xl mb-3">NOT AUTHORIZED</h1>
          <p className="mako-body text-muted mb-3">
            Connect the admin wallet to view this page.
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
    <div className="bg-mako-red/15 border-b-2 border-mako-red px-6 py-3 mako-label text-mako-red">
      DEGRADED · MISSING {streams.map((s) => s.toUpperCase()).join(' · ')} STREAM{streams.length > 1 ? 'S' : ''} · FIELDS BELOW SHOW — INSTEAD OF A MISLEADING 0
    </div>
  );
}

/**
 * Renders `—` when any of the underlying event streams the field depends
 * on failed to scan, otherwise returns the value formatter output. Keeps
 * the dashboard honest: a zero always means "really zero," never "we
 * don't know." The banner explains the — to the viewer.
 */
export function Honest({
  value,
  dependsOn,
  degraded,
}: {
  value: string;
  dependsOn: string[];
  degraded: string[];
}) {
  const missing = dependsOn.some((d) => degraded.includes(d));
  if (missing) return <span className="text-subtle">—</span>;
  return <>{value}</>;
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
      sentence = `${short(a.user)} BET ${fourDp(a.amountUsdc)} USDC ${a.isYes ? 'YES' : 'NO'} ON #${a.marketId}`;
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
      sentence = `${short(a.user)} CLAIMED ${fourDp(a.amountUsdc)} USDC ON #${a.marketId}`;
      break;
    case 'fee':
      kindLabel = 'FEE';
      sentence = `${short(a.user)} CLAIMED ${fourDp(a.amountUsdc)} USDC CREATOR FEE ON #${a.marketId}`;
      break;
  }

  return (
    <div className="border-b-2 border-ink/10 px-6 py-3 flex items-center gap-4 mako-label">
      <span className="text-muted w-16 shrink-0">{kindLabel}</span>
      <span className="flex-1 min-w-0 truncate text-ink normal-case tracking-normal font-semibold text-[12px]">
        {sentence}
      </span>
      <a
        href={explorerTx(a.txHash)}
        target="_blank"
        rel="noreferrer noopener"
        className="text-subtle hover:text-ink shrink-0 tabular-nums"
      >
        {ago}
      </a>
    </div>
  );
}
