'use client';

import Link from 'next/link';
import { useIsAdmin } from '@/lib/admin';
import { useAdminAnalytics } from '@/lib/admin-analytics';
import { AdminNav } from '@/components/AdminNav';
import {
  TopBar,
  NotAuthorized,
  ActivityRow,
  fourDp,
} from '@/components/admin-shared';

/**
 * Admin overview hub. Top-level tiles + last 10 activity rows.
 * Every /admin/* page shares the same shell: TopBar, AdminNav, then content.
 */
export default function AdminOverviewPage() {
  const isAdmin = useIsAdmin();
  const { data, isLoading, error } = useAdminAnalytics();

  if (!isAdmin) return <NotAuthorized />;

  return (
    <main className="flex-1 flex flex-col w-full pb-16">
      <TopBar />
      <AdminNav active="overview" />

      <div className="px-6 md:px-8 py-8 border-b border-black">
        <div className="text-[10px] font-black uppercase tracking-widest text-muted mb-2">
          [ ADMIN · OVERVIEW ]
        </div>
        <h1 className="text-3xl font-black uppercase tracking-tight">MAKO MARKETS</h1>
        <p className="text-muted text-[11px] font-bold uppercase tracking-widest mt-2">
          PLATFORM HEALTH · REFRESHED EVERY 30s
        </p>
      </div>

      {isLoading && !data ? (
        <div className="py-20 text-center font-black uppercase tracking-widest text-muted text-sm border-b border-black">
          LOADING…
        </div>
      ) : error && !data ? (
        <div className="py-20 text-center font-black uppercase tracking-widest text-warning text-sm border-b border-black">
          ANALYTICS UNAVAILABLE · RETRY
        </div>
      ) : data ? (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 divide-x divide-y md:divide-y-0 divide-black border-b border-black">
            <Tile
              label="MARKETS"
              value={data.totals.marketCount.toString()}
              sub={`${data.totals.resolvedCount} RESOLVED · ${data.totals.pendingResolveCount} PENDING`}
            />
            <Tile
              label="VOLUME"
              value={`${fourDp(data.totals.totalVolumeMon)} MON`}
              sub={`${data.totals.uniqueBettors} UNIQUE BETTORS`}
            />
            <Tile
              label="USERS"
              value={data.totals.uniqueBettors.toString()}
              sub={`${data.totals.uniqueCreators} CREATORS`}
            />
            <Tile
              label="TREASURY"
              value={`${fourDp(data.totals.treasuryMon)} MON`}
              sub="PROTOCOL FEES"
            />
          </div>

          <DauStrip dau={data.dau} />

          <div className="px-6 md:px-8 py-6 border-b border-black flex items-center justify-between">
            <div className="text-[10px] font-black uppercase tracking-widest text-muted">
              LATEST ACTIVITY
            </div>
            <Link
              href="/admin/activity"
              className="text-[10px] font-black uppercase tracking-widest hover:bg-black hover:text-background px-2 py-1 -mr-2 transition-colors"
            >
              VIEW ALL &gt;
            </Link>
          </div>

          {data.activity.length === 0 ? (
            <div className="py-20 text-center font-black uppercase tracking-widest text-muted text-sm border-b border-black">
              NO ACTIVITY YET
            </div>
          ) : (
            data.activity.slice(0, 10).map((a) => (
              <ActivityRow key={`${a.txHash}-${a.kind}`} activity={a} />
            ))
          )}
        </>
      ) : null}
    </main>
  );
}

function DauStrip({ dau }: { dau: Array<{ dateISO: string; wallets: number; bets: number }> }) {
  const maxWallets = dau.reduce((m, d) => Math.max(m, d.wallets), 0);
  const totalWallets = new Set<string>(); // placeholder; we don't have the actual addresses here
  const totalBets = dau.reduce((acc, d) => acc + d.bets, 0);
  // maxWallets drives bar height so a day with 1 bettor still shows on a small platform.
  // totalWallets is intentionally unused — the real "unique bettors" count is on the tile
  // above. This strip shows the daily activity curve, not the running total.
  void totalWallets;

  return (
    <div className="border-b border-black px-6 md:px-8 py-6">
      <div className="flex items-baseline justify-between mb-4">
        <div className="text-[10px] font-black uppercase tracking-widest text-muted">
          DAILY ACTIVE WALLETS · LAST 30 DAYS
        </div>
        <div className="text-[10px] font-black uppercase tracking-widest text-subtle tabular-nums">
          {totalBets} BETS
        </div>
      </div>
      <div className="flex items-end gap-[3px] h-20">
        {dau.map((d, i) => {
          const pct = maxWallets === 0 ? 0 : Math.max(4, Math.round((d.wallets / maxWallets) * 100));
          return (
            <div
              key={d.dateISO}
              className="flex-1 flex flex-col justify-end items-stretch min-w-0"
              title={`${d.dateISO} · ${d.wallets} wallets · ${d.bets} bets`}
            >
              <div
                className={`dau-bar w-full ${d.wallets === 0 ? 'bg-foreground/10' : 'bg-foreground'}`}
                style={{
                  height: `${d.wallets === 0 ? 4 : pct}%`,
                  ['--i' as string]: i,
                }}
              />
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between mt-2 text-[9px] font-black uppercase tracking-widest text-subtle tabular-nums">
        <span>{dau[0]?.dateISO ?? ''}</span>
        <span>TODAY</span>
      </div>
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="px-6 py-6">
      <div className="text-[10px] font-black uppercase tracking-widest text-muted mb-2">
        {label}
      </div>
      <div className="text-3xl font-black tabular-nums leading-none">{value}</div>
      {sub ? (
        <div className="text-[10px] font-black uppercase tracking-widest text-subtle mt-3">
          {sub}
        </div>
      ) : null}
    </div>
  );
}
