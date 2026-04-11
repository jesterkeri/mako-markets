'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useAccount, useReadContracts } from 'wagmi';
import { useMarkets } from '@/lib/hooks';
import { makoContract, type MarketWithId } from '@/lib/contract';
import { MarketCard } from '@/components/MarketCard';
import { MarketResolveActions } from '@/components/MarketResolveActions';
import { MarketClaimAction } from '@/components/MarketClaimAction';
import { useIsAdmin } from '@/lib/admin';

/**
 * /me — the user's position view.
 *
 * Shows every market where the connected wallet has a non-zero
 * yesBet or noBet, split into ACTIVE (open + unresolved) and CLOSED
 * (past closeTime or already resolved). Reuses the home feed's
 * MarketCard for the list rows.
 *
 * Data flow: useMarkets() for the global market list, then fan-out
 * useReadContracts over `getUserBet(id, address)` to find which
 * markets the user has a position in. Both queries auto-refetch
 * every 5 seconds so new bets and closures show up live.
 */

type PositionsTab = 'active' | 'closed';

type UserPosition = {
  market: MarketWithId;
  yesBet: bigint;
  noBet: bigint;
  hasClaimed: boolean;
};

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

export default function MyMarketsPage() {
  const { address } = useAccount();
  const { markets, isLoading, refetch } = useMarkets();
  const isAdmin = useIsAdmin();
  const [tab, setTab] = useState<PositionsTab>('active');

  // Batched read: one getUserBet call per market. wagmi dedupes and caches.
  const {
    data: betsData,
    isLoading: isBetsLoading,
    error: betsError,
  } = useReadContracts({
    contracts: markets.map(
      (m) =>
        ({
          ...makoContract,
          functionName: 'getUserBet' as const,
          args: [m.id, address ?? ZERO_ADDRESS] as const,
        }) as const,
    ),
    query: {
      enabled: !!address && markets.length > 0,
      refetchInterval: 5000,
    },
  });

  // Join markets with the user's positions. Show every market the wallet has
  // a non-zero position in — including ADHOC. ADHOC is retired from the
  // discovery surface (home feed, /create) but users must always see their
  // own historical positions regardless of mType.
  const anyReadFailed = !!betsData?.some((r) => r.status === 'failure');
  const userPositions: UserPosition[] = useMemo(() => {
    if (!betsData || !address) return [];
    const out: UserPosition[] = [];
    for (let i = 0; i < markets.length; i++) {
      const res = betsData[i];
      if (!res || res.status !== 'success' || !res.result) continue;
      // viem decodes multi-return as a positional tuple (with named props
      // attached); positional access is safe.
      const [yes, no, hasClaimed] = res.result as unknown as [
        bigint,
        bigint,
        boolean,
      ];
      if (yes === 0n && no === 0n) continue;
      out.push({ market: markets[i], yesBet: yes, noBet: no, hasClaimed });
    }
    return out;
  }, [betsData, markets, address]);

  // Split into active / closed buckets.
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const active = userPositions.filter(
    (p) => !p.market.resolved && p.market.closeTime > nowSec,
  );
  const closed = userPositions.filter(
    (p) => p.market.resolved || p.market.closeTime <= nowSec,
  );

  const shown = tab === 'active' ? active : closed;

  // Not-connected state
  if (!address) {
    return (
      <main className="flex-1 flex flex-col items-center justify-center gap-4 py-16 px-6 text-center">
        <h1 className="text-3xl font-black uppercase tracking-tight">NOT CONNECTED</h1>
        <p className="text-muted text-xs font-bold uppercase tracking-widest max-w-xs">
          CONNECT YOUR WALLET TO SEE MARKETS YOU HAVE A POSITION IN
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

  return (
    <main className="flex-1 flex flex-col w-full pb-16">
      <div className="px-6 md:px-8 py-4 border-b border-black">
        <Link
          href="/"
          className="text-foreground text-sm font-black uppercase tracking-widest hover:bg-black hover:text-background px-2 py-1 -ml-2 inline-block transition-colors"
        >
          &lt; BACK
        </Link>
      </div>

      <div className="px-6 md:px-8 py-8 border-b border-black">
        <div className="text-[10px] font-black uppercase tracking-widest text-muted mb-2">
          [ POSITIONS ]
        </div>
        <h1 className="text-3xl font-black uppercase tracking-tight">MY MARKETS</h1>
        <p className="text-muted text-[11px] font-bold uppercase tracking-widest mt-2 break-all">
          {address.slice(0, 6)}…{address.slice(-4)}
        </p>
      </div>

      {/* Tabs */}
      <div className="flex flex-row divide-x divide-black border-b border-black">
        <button
          type="button"
          onClick={() => setTab('active')}
          className={`flex-1 py-3 font-black text-xs uppercase tracking-widest transition-colors ${
            tab === 'active'
              ? 'bg-black text-background'
              : 'hover:bg-black hover:text-background'
          }`}
        >
          ACTIVE · {active.length}
        </button>
        <button
          type="button"
          onClick={() => setTab('closed')}
          className={`flex-1 py-3 font-black text-xs uppercase tracking-widest transition-colors ${
            tab === 'closed'
              ? 'bg-black text-background'
              : 'hover:bg-black hover:text-background'
          }`}
        >
          CLOSED · {closed.length}
        </button>
      </div>

      {/* Read-error banner — distinguishes an RPC/contract failure from a
          legitimate empty positions list. The fanout is a batched call: if
          the whole query errors we show a toast-style banner; if individual
          rows failed (partial) we still render what we have but warn. */}
      {(betsError || anyReadFailed) && (
        <div className="px-6 md:px-8 py-3 border-b border-warning bg-warning/10 text-center">
          <span className="block text-[10px] font-black tracking-widest text-warning uppercase">
            [ READ ERROR ] · SOME POSITIONS MAY BE MISSING · RETRYING…
          </span>
        </div>
      )}

      {/* List */}
      <div className="flex flex-col w-full pb-8">
        {(isLoading || isBetsLoading) && userPositions.length === 0 ? (
          <div className="py-20 text-center font-black uppercase tracking-widest border-b border-black text-muted text-sm">
            LOADING YOUR POSITIONS…
          </div>
        ) : shown.length === 0 ? (
          <div className="py-20 text-center font-black uppercase tracking-widest border-b border-black text-muted text-sm">
            {tab === 'active' ? 'NO ACTIVE POSITIONS' : 'NO CLOSED POSITIONS'}
            <div className="text-subtle text-[10px] mt-2 normal-case tracking-wide">
              {tab === 'active'
                ? 'Place a bet from the feed to see it here'
                : 'Your resolved + expired bets will appear here'}
            </div>
          </div>
        ) : (
          shown.map(({ market }) => {
            // Admin inline resolve on closed-unresolved markets (/me CLOSED only).
            const showAdminResolve =
              isAdmin && tab === 'closed' && !market.resolved;

            // Inline claim on closed-resolved markets (any user, any wallet).
            // The component itself decides whether to render based on position.
            const showInlineClaim = tab === 'closed' && market.resolved;

            return (
              <div key={market.id.toString()} className="w-full">
                <Link
                  href={`/market/${market.id.toString()}`}
                  className="w-full block"
                >
                  <MarketCard market={market} />
                </Link>
                {showAdminResolve && (
                  <MarketResolveActions market={market} onResolved={refetch} />
                )}
                {showInlineClaim && (
                  <MarketClaimAction market={market} onClaimed={refetch} />
                )}
              </div>
            );
          })
        )}
      </div>
    </main>
  );
}
