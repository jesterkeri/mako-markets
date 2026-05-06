'use client';

import { useMemo, useState } from 'react';
import { useIsAdmin } from '@/lib/admin';
import { useAdminAnalytics, UNAUTHORIZED } from '@/lib/admin-analytics';
import { AdminNav } from '@/components/AdminNav';
import { AdminLogin } from '@/components/AdminLogin';
import {
  TopBar,
  NotAuthorized,
  DegradedBanner,
  Honest,
  fourDp,
  short,
  explorerAddress,
} from '@/components/admin-shared';
import { humanizeUntil } from '@/lib/time';
import { useNowSec } from '@/lib/use-now';

/**
 * Users list. Sortable by volume, bet count, or recency.
 * Addresses link to the Monad testnet explorer (URL read from chain config).
 */
type SortKey = 'volume' | 'bets' | 'earned' | 'recent';

export default function AdminUsersPage() {
  const isAdmin = useIsAdmin();
  const { data, isLoading, error } = useAdminAnalytics({ enabled: isAdmin });
  const [sortKey, setSortKey] = useState<SortKey>('volume');

  const sortedUsers = useMemo(() => {
    if (!data) return [];
    const copy = [...data.users];
    if (sortKey === 'volume') {
      // BigInt comparison on the raw wei string avoids the Number() float
      // precision pitfall that shows up once volumes get large.
      copy.sort((a, b) => {
        const bw = BigInt(b.volumeBaseUnits);
        const aw = BigInt(a.volumeBaseUnits);
        if (bw === aw) return 0;
        return bw > aw ? 1 : -1;
      });
    } else if (sortKey === 'bets') {
      copy.sort((a, b) => b.betCount - a.betCount);
    } else if (sortKey === 'earned') {
      // BigInt compare on raw wei, same pattern as volume — avoids the
      // Number() precision fall-over at higher earning levels.
      copy.sort((a, b) => {
        const bw = BigInt(b.creatorFeesEarnedBaseUnits);
        const aw = BigInt(a.creatorFeesEarnedBaseUnits);
        if (bw === aw) return 0;
        return bw > aw ? 1 : -1;
      });
    } else {
      copy.sort((a, b) => b.lastSeenSec - a.lastSeenSec);
    }
    return copy;
  }, [data, sortKey]);

  if (!isAdmin) return <NotAuthorized />;
  if (error instanceof Error && error.message === UNAUTHORIZED) return <AdminLogin />;

  return (
    <main className="flex-1 flex flex-col w-full pb-16">
      <TopBar />
      <AdminNav active="users" />
      {data ? <DegradedBanner streams={data.degraded} /> : null}

      <div className="px-6 lg:px-8 py-8 border-b-2 border-ink">
        <div className="mako-label text-muted mb-2">ADMIN · USERS</div>
        <h1 className="mako-display text-3xl md:text-4xl mb-2 text-canvas-fg">
          {!data
            ? '…'
            : data.degraded.includes('bet') || data.degraded.includes('market')
              ? '—'
              : `${data.users.length} USER${data.users.length === 1 ? '' : 'S'}`}
        </h1>
        <p className="mako-label text-muted">
          {data?.window.bounded
            ? `EVERYONE WHO BET OR CREATED A MARKET IN THE LAST ${Number(data.window.blocksCovered).toLocaleString()} BLOCKS`
            : 'EVERYONE WHO BET OR CREATED A MARKET'}
        </p>
      </div>

      <div className="px-6 lg:px-8 py-4 border-b-2 border-ink flex gap-3 flex-wrap">
        {(['volume', 'bets', 'earned', 'recent'] as const).map((k) => {
          const isActive = sortKey === k;
          return (
            <button
              key={k}
              type="button"
              onClick={() => setSortKey(k)}
              aria-current={isActive ? 'page' : undefined}
              className={`
                mako-label px-4 py-2 rounded-full border-2 border-ink transition-all whitespace-nowrap
                ${isActive
                  ? 'bg-ink text-paper shadow-[4px_4px_0_0_#D94A3D] -translate-y-[2px] -translate-x-[2px]'
                  : 'bg-paper text-ink shadow-brutal-sm hover:-translate-y-[1px] hover:-translate-x-[1px]'}
              `}
            >
              SORT · {k === 'volume' ? 'VOLUME' : k === 'bets' ? 'BETS' : k === 'earned' ? 'EARNED' : 'RECENT'}
            </button>
          );
        })}
      </div>

      {isLoading && !data ? (
        <div className="py-20 text-center mako-label text-muted border-b-2 border-ink">
          LOADING…
        </div>
      ) : error && !data ? (
        <div className="py-20 text-center mako-label text-mako-red border-b-2 border-ink">
          ANALYTICS UNAVAILABLE · RETRY
        </div>
      ) : sortedUsers.length === 0 ? (
        <div className="py-20 text-center mako-label text-muted border-b-2 border-ink">
          {data && (data.degraded.includes('bet') || data.degraded.includes('market'))
            ? 'USER DATA UNAVAILABLE · EVENT STREAM FAILED'
            : 'NO USERS IN THIS WINDOW'}
        </div>
      ) : (
        sortedUsers.map((u) => <UserRow key={u.address} user={u} degraded={data?.degraded ?? []} />)
      )}
    </main>
  );
}

function UserRow({
  user: u,
  degraded,
}: {
  user: {
    address: `0x${string}`;
    betCount: number;
    volumeUsdc: string;
    volumeBaseUnits: string;
    marketsCreated: number;
    creatorFeesEarnedUsdc: string;
    creatorFeesEarnedBaseUnits: string;
    claimedUsdc: string;
    firstSeenSec: number;
    lastSeenSec: number;
  };
  degraded: string[];
}) {
  const nowSec = useNowSec();
  return (
    <div className="border-b-2 border-ink/10 px-6 lg:px-8 py-5">
      <div className="flex items-baseline justify-between gap-3">
        <a
          href={explorerAddress(u.address)}
          target="_blank"
          rel="noreferrer noopener"
          className="mako-mono text-[11px] hover:underline break-all"
        >
          {short(u.address)}
        </a>
        <span className="mako-label text-subtle tabular-nums">
          LAST SEEN {humanizeUntil(u.lastSeenSec - nowSec)}
        </span>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 mako-label text-muted">
        <span>
          VOLUME{' '}
          <span className="text-ink tabular-nums">
            <Honest value={`${fourDp(u.volumeUsdc)} USDC`} dependsOn={['bet']} degraded={degraded} />
          </span>
        </span>
        <span>
          BETS{' '}
          <span className="text-ink tabular-nums">
            <Honest value={u.betCount.toString()} dependsOn={['bet']} degraded={degraded} />
          </span>
        </span>
        <span>
          CREATED{' '}
          <span className="text-ink tabular-nums">
            <Honest value={u.marketsCreated.toString()} dependsOn={['market']} degraded={degraded} />
          </span>
        </span>
        <span>
          EARNED{' '}
          <span className="text-ink tabular-nums">
            <Honest value={`${fourDp(u.creatorFeesEarnedUsdc)} USDC`} dependsOn={['fee']} degraded={degraded} />
          </span>
        </span>
        <span>
          CLAIMED{' '}
          <span className="text-ink tabular-nums">
            <Honest value={`${fourDp(u.claimedUsdc)} USDC`} dependsOn={['claim']} degraded={degraded} />
          </span>
        </span>
      </div>
    </div>
  );
}
