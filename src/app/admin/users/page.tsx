'use client';

import { useMemo, useState } from 'react';
import { useIsAdmin } from '@/lib/admin';
import { useAdminAnalytics } from '@/lib/admin-analytics';
import { AdminNav } from '@/components/AdminNav';
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
        const bw = BigInt(b.volumeWei);
        const aw = BigInt(a.volumeWei);
        if (bw === aw) return 0;
        return bw > aw ? 1 : -1;
      });
    } else if (sortKey === 'bets') {
      copy.sort((a, b) => b.betCount - a.betCount);
    } else if (sortKey === 'earned') {
      // BigInt compare on raw wei, same pattern as volume — avoids the
      // Number() precision fall-over at higher earning levels.
      copy.sort((a, b) => {
        const bw = BigInt(b.creatorFeesEarnedWei);
        const aw = BigInt(a.creatorFeesEarnedWei);
        if (bw === aw) return 0;
        return bw > aw ? 1 : -1;
      });
    } else {
      copy.sort((a, b) => b.lastSeenSec - a.lastSeenSec);
    }
    return copy;
  }, [data, sortKey]);

  if (!isAdmin) return <NotAuthorized />;

  return (
    <main className="flex-1 flex flex-col w-full pb-16">
      <TopBar />
      <AdminNav active="users" />
      {data ? <DegradedBanner streams={data.degraded} /> : null}

      <div className="px-6 md:px-8 py-8 border-b border-black">
        <div className="text-[10px] font-black uppercase tracking-widest text-muted mb-2">
          [ ADMIN · USERS ]
        </div>
        <h1 className="text-3xl font-black uppercase tracking-tight">
          {!data
            ? '…'
            : data.degraded.includes('bet') || data.degraded.includes('market')
              ? '—'
              : `${data.users.length} USER${data.users.length === 1 ? '' : 'S'}`}
        </h1>
        <p className="text-muted text-[11px] font-bold uppercase tracking-widest mt-2">
          {data?.window.bounded
            ? `EVERYONE WHO BET OR CREATED A MARKET IN THE LAST ${Number(data.window.blocksCovered).toLocaleString()} BLOCKS`
            : 'EVERYONE WHO BET OR CREATED A MARKET'}
        </p>
      </div>

      <div className="flex divide-x divide-black border-b border-black overflow-x-auto">
        {(['volume', 'bets', 'earned', 'recent'] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setSortKey(k)}
            className={`flex-1 min-w-[90px] py-3 text-[10px] font-black uppercase tracking-widest transition-colors ${
              sortKey === k
                ? 'bg-black text-background'
                : 'hover:bg-black hover:text-background'
            }`}
          >
            SORT · {k === 'volume' ? 'VOLUME' : k === 'bets' ? 'BETS' : k === 'earned' ? 'EARNED' : 'RECENT'}
          </button>
        ))}
      </div>

      {isLoading && !data ? (
        <div className="py-20 text-center font-black uppercase tracking-widest text-muted text-sm border-b border-black">
          LOADING…
        </div>
      ) : error && !data ? (
        <div className="py-20 text-center font-black uppercase tracking-widest text-warning text-sm border-b border-black">
          ANALYTICS UNAVAILABLE · RETRY
        </div>
      ) : sortedUsers.length === 0 ? (
        <div className="py-20 text-center font-black uppercase tracking-widest text-muted text-sm border-b border-black">
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
    volumeMon: string;
    volumeWei: string;
    marketsCreated: number;
    creatorFeesEarnedMon: string;
    creatorFeesEarnedWei: string;
    claimedMon: string;
    firstSeenSec: number;
    lastSeenSec: number;
  };
  degraded: string[];
}) {
  const nowSec = useNowSec();
  return (
    <div className="border-b border-black px-6 md:px-8 py-5">
      <div className="flex items-baseline justify-between gap-3">
        <a
          href={explorerAddress(u.address)}
          target="_blank"
          rel="noreferrer noopener"
          className="text-[11px] font-mono hover:underline break-all"
        >
          {short(u.address)}
        </a>
        <span className="text-[10px] font-black uppercase tracking-widest text-subtle tabular-nums">
          LAST SEEN {humanizeUntil(u.lastSeenSec - nowSec)}
        </span>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-[10px] font-black uppercase tracking-widest text-muted">
        <span>
          VOLUME{' '}
          <span className="text-foreground tabular-nums">
            <Honest value={`${fourDp(u.volumeMon)} MON`} dependsOn={['bet']} degraded={degraded} />
          </span>
        </span>
        <span>
          BETS{' '}
          <span className="text-foreground tabular-nums">
            <Honest value={u.betCount.toString()} dependsOn={['bet']} degraded={degraded} />
          </span>
        </span>
        <span>
          CREATED{' '}
          <span className="text-foreground tabular-nums">
            <Honest value={u.marketsCreated.toString()} dependsOn={['market']} degraded={degraded} />
          </span>
        </span>
        <span>
          EARNED{' '}
          <span className="text-foreground tabular-nums">
            <Honest value={`${fourDp(u.creatorFeesEarnedMon)} MON`} dependsOn={['fee']} degraded={degraded} />
          </span>
        </span>
        <span>
          CLAIMED{' '}
          <span className="text-foreground tabular-nums">
            <Honest value={`${fourDp(u.claimedMon)} MON`} dependsOn={['claim']} degraded={degraded} />
          </span>
        </span>
      </div>
    </div>
  );
}
