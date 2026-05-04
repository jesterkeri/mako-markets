'use client';

import React from 'react';
import Link from 'next/link';
import { useIsAdmin } from '@/lib/admin';
import { useAdminAnalytics, UNAUTHORIZED } from '@/lib/admin-analytics';
import { AdminNav } from '@/components/AdminNav';
import { AdminLogin } from '@/components/AdminLogin';
import {
  TopBar,
  NotAuthorized,
  ActivityRow,
  DegradedBanner,
  Honest,
  fourDp,
} from '@/components/admin-shared';
import { DauChart, UserGrowthChart } from '@/components/admin-charts';

/**
 * Admin overview hub. Top-level tiles + last 10 activity rows.
 * Every /admin/* page shares the same shell: TopBar, AdminNav, then content.
 */
export default function AdminOverviewPage() {
  const isAdmin = useIsAdmin();
  const { data, isLoading, error } = useAdminAnalytics({ enabled: isAdmin });

  if (!isAdmin) return <NotAuthorized />;
  if (error instanceof Error && error.message === UNAUTHORIZED) return <AdminLogin />;

  return (
    <main className="flex-1 flex flex-col w-full pb-16">
      <TopBar />
      <AdminNav active="overview" />
      {data ? <DegradedBanner streams={data.degraded} /> : null}

      <div className="px-6 lg:px-8 py-8 border-b-2 border-ink">
        <div className="mako-label text-muted mb-2">ADMIN · OVERVIEW</div>
        <h1 className="mako-display text-3xl md:text-4xl mb-2 text-canvas-fg">MAKO MARKET</h1>
        <p className="mako-label text-muted">
          PLATFORM HEALTH · REFRESHED EVERY 30s
          {data?.window.bounded
            ? ` · EVENT SCAN: LAST ${Number(data.window.blocksCovered).toLocaleString()} BLOCKS`
            : null}
        </p>
      </div>

      {isLoading && !data ? (
        <div className="py-20 text-center mako-label text-muted border-b-2 border-ink">
          LOADING…
        </div>
      ) : error && !data ? (
        <div className="py-20 text-center mako-label text-mako-red border-b-2 border-ink">
          ANALYTICS UNAVAILABLE · RETRY
        </div>
      ) : data ? (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 divide-x-2 divide-y-2 md:divide-y-0 divide-ink border-b-2 border-ink">
            <Tile
              label="MARKETS"
              value={<>{data.totals.marketCount.toString()}</>}
              sub={`${data.totals.resolvedCount} RESOLVED · ${data.totals.pendingResolveCount} PENDING`}
            />
            <Tile
              label="VOLUME"
              value={<>{fourDp(data.totals.totalVolumeUsdc)} USDC</>}
              sub={
                <Honest
                  value={`${data.totals.uniqueBettors} UNIQUE BETTORS`}
                  dependsOn={['bet']}
                  degraded={data.degraded}
                />
              }
            />
            <Tile
              label="USERS"
              value={
                <Honest
                  value={data.totals.uniqueBettors.toString()}
                  dependsOn={['bet']}
                  degraded={data.degraded}
                />
              }
              sub={
                <Honest
                  value={`${data.totals.uniqueCreators} CREATORS`}
                  dependsOn={['market']}
                  degraded={data.degraded}
                />
              }
            />
          </div>

          <div className="grid grid-cols-2 md:grid-cols-3 divide-x-2 divide-y-2 md:divide-y-0 divide-ink border-b-2 border-ink">
            <Tile
              label="PROTOCOL FEES"
              value={
                <Honest
                  value={`${fourDp(data.totals.totalProtocolFeesUsdc)} USDC`}
                  dependsOn={['withdraw']}
                  degraded={data.degraded}
                />
              }
              sub={`${fourDp(data.totals.treasuryUsdc)} USDC IN TREASURY NOW`}
            />
            <Tile
              label="CREATOR FEES PAID"
              value={
                <Honest
                  value={`${fourDp(data.totals.creatorFeesPaidUsdc)} USDC`}
                  dependsOn={['fee']}
                  degraded={data.degraded}
                />
              }
              sub="TOTAL EARNED BY CREATORS"
            />
            <Tile
              label="TOTAL TAKE"
              value={
                <Honest
                  value={`${fourDp(
                    (parseFloat(data.totals.totalProtocolFeesUsdc) + parseFloat(data.totals.creatorFeesPaidUsdc)).toString(),
                  )} USDC`}
                  dependsOn={['fee', 'withdraw']}
                  degraded={data.degraded}
                />
              }
              sub="PROTOCOL + CREATOR FEES"
            />
          </div>

          {(() => {
            // When the server has a bounded scan window (public-RPC
            // fallback, say last 10k blocks ≈ 3h), the chart datapoints
            // for days outside the window are fabricated zeros. Labeling
            // that "LAST 30 DAYS" would be a lie. Relabel + retitle.
            const bounded = data.window.bounded;
            const growthTitle = bounded
              ? `USER GROWTH · LAST ${Number(data.window.blocksCovered).toLocaleString()} BLOCKS`
              : 'USER GROWTH · LAST 30 DAYS';
            const dauTitle = bounded
              ? `DAILY ACTIVE WALLETS · LAST ${Number(data.window.blocksCovered).toLocaleString()} BLOCKS`
              : 'DAILY ACTIVE WALLETS · LAST 30 DAYS';
            const growthUnavailable =
              data.degraded.includes('bet') || data.degraded.includes('market');
            const dauUnavailable = data.degraded.includes('bet');
            const growthRight = growthUnavailable
              ? undefined
              : data.userGrowth.length > 0
                ? `${data.userGrowth[data.userGrowth.length - 1]!.cumulativeUsers} TOTAL`
                : undefined;
            const dauRight = dauUnavailable
              ? undefined
              : `${data.dau.reduce((acc, d) => acc + d.bets, 0)} BETS`;
            return (
              <>
                <ChartBlock title={growthTitle} right={growthRight} unavailable={growthUnavailable}>
                  <UserGrowthChart data={data.userGrowth} />
                </ChartBlock>
                <ChartBlock title={dauTitle} right={dauRight} unavailable={dauUnavailable}>
                  <DauChart data={data.dau} />
                </ChartBlock>
              </>
            );
          })()}

          <div className="px-6 lg:px-8 py-5 border-b-2 border-ink flex items-center justify-between bg-surface-elevated">
            <div className="mako-label text-muted">LATEST ACTIVITY</div>
            <Link
              href="/admin/activity"
              className="mako-label text-muted hover:text-ink transition-colors"
            >
              VIEW ALL →
            </Link>
          </div>

          {data.activity.length === 0 ? (
            <div className="py-20 text-center mako-label text-muted border-b-2 border-ink">
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

function ChartBlock({
  title,
  right,
  unavailable,
  children,
}: {
  title: string;
  right?: string;
  unavailable: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b-2 border-ink px-6 lg:px-8 py-6">
      <div className="flex items-baseline justify-between mb-4">
        <div className="mako-label text-muted">{title}</div>
        {right ? (
          <div className="mako-label text-subtle tabular-nums">{right}</div>
        ) : null}
      </div>
      {unavailable ? (
        <div className="h-36 flex items-center justify-center mako-label text-subtle">
          — STREAM UNAVAILABLE
        </div>
      ) : (
        children
      )}
    </div>
  );
}

function Tile({
  label,
  value,
  sub,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
}) {
  return (
    <div className="px-6 py-6 bg-paper">
      <div className="mako-label text-muted mb-2">{label}</div>
      <div className="mako-display text-3xl tabular-nums leading-none">{value}</div>
      {sub ? <div className="mako-label text-subtle mt-3">{sub}</div> : null}
    </div>
  );
}
