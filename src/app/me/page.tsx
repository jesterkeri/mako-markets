'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useAccount, useReadContracts } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useMarkets } from '@/lib/hooks';
import { makoContract, type MarketWithId } from '@/lib/contract';
import { MarketCard } from '@/components/MarketCard';
import { MarketResolveActions } from '@/components/MarketResolveActions';
import { MarketClaimAction } from '@/components/MarketClaimAction';
import { ThemeToggle } from '@/components/ThemeToggle';
import { MobileChromeHeader } from '@/components/MobileChromeHeader';
import { AvatarCircle } from '@/components/AvatarCircle';
import { useIsAdmin } from '@/lib/admin';
import { useUser } from '@/lib/use-user';
import { getDisplayName, getIdentityLabel } from '@/lib/user-display';

type PositionsTab = 'active' | 'closed';

type UserPosition = {
  market: MarketWithId;
  yesBet: bigint;
  noBet: bigint;
  hasClaimed: boolean;
};

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

export default function MyMarketsPage() {
  const { address: connectedWallet } = useAccount();
  const {
    user,
    isLoading: isUserLoading,
    isError: isUserError,
    refetch: refetchUser,
  } = useUser();
  // Phase 1H integration fix: Magic users have no `useAccount()` address
  // but their bets are owned by their derived Safe. Magic Safe takes
  // precedence; wallet-only users keep the previous behavior. Wallet-
  // session users have NO Safe — their bets live under the connected
  // wallet, same as wagmi-only users (plan step 18 narrowing).
  const address =
    user?.authType === 'magic'
      ? (user.safeAddress as `0x${string}`)
      : connectedWallet;
  const { markets, isLoading, refetch } = useMarkets();
  const isAdmin = useIsAdmin();
  const [tab, setTab] = useState<PositionsTab>('active');

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

  const anyReadFailed = !!betsData?.some((r) => r.status === 'failure');
  const userPositions: UserPosition[] = useMemo(() => {
    if (!betsData || !address) return [];
    const out: UserPosition[] = [];
    for (let i = 0; i < markets.length; i++) {
      const res = betsData[i];
      if (!res || res.status !== 'success' || !res.result) continue;
      const [yes, no, hasClaimed] = res.result as unknown as [bigint, bigint, boolean];
      if (yes === 0n && no === 0n) continue;
      out.push({ market: markets[i], yesBet: yes, noBet: no, hasClaimed });
    }
    return out;
  }, [betsData, markets, address]);

  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const active = userPositions.filter(
    (p) => !p.market.resolved && p.market.closeTime > nowSec,
  );
  const closed = userPositions.filter(
    (p) => p.market.resolved || p.market.closeTime <= nowSec,
  );

  const shown = tab === 'active' ? active : closed;

  // Sub-F round-2 MINOR 1: Magic users start with `user === null` while
  // /api/user/me is in flight. Without this gate, /me flashes the full
  // NOT CONNECTED CTA before useUser() resolves, then snaps to authed
  // state — auth-surface disagreement on cold load. Render a quiet
  // skeleton while the auth probe is mid-flight; only fall through to
  // the unauthenticated branch after we know we're actually unauthed.
  //
  // Sub-F round-3 NIT 1: skeleton gate widened to fire for ALL
  // isUserLoading states, including when connectedWallet is truthy.
  // The cost is one skeleton frame for wallet-only cold loads; the
  // benefit is mixed-state users no longer flash external-wallet
  // positions before Magic Safe priority resolves.
  if (isUserLoading) {
    return (
      <main className="flex-1 flex flex-col items-center justify-center gap-6 py-20 px-6 text-center">
        <div className="mako-skeleton h-[160px] w-full max-w-sm" aria-hidden="true" />
      </main>
    );
  }

  // Sub-F round-3 MINOR 1: /api/user/me errored with no cached user.
  // Without this branch, /me silently degrades to NOT CONNECTED for an
  // authed Magic user when the auth probe 500s — same auth-surface
  // disagreement AuthMenu defends against. Wallet-only users bypass
  // because their auth is independent of /api/user/me.
  if (isUserError && !user && !connectedWallet) {
    return (
      <main className="flex-1 flex flex-col items-center justify-center gap-6 py-20 px-6 text-center">
        <div className="-rotate-2">
          <div className="bg-paper border-2 border-ink rounded-2xl shadow-brutal p-8">
            <h1 className="mako-display text-2xl md:text-3xl mb-3">SIGN-IN UNAVAILABLE</h1>
            <p className="mako-body text-muted max-w-xs mb-4">
              We couldn&apos;t check your sign-in status. Try again in a moment.
            </p>
            <button
              type="button"
              onClick={() => {
                void refetchUser();
              }}
              className="mako-button mako-button--signal mako-label"
            >
              RETRY
            </button>
          </div>
        </div>
        <Link href="/" className="mako-button mako-label">
          BACK TO FEED
        </Link>
      </main>
    );
  }

  if (!address) {
    return (
      <main className="flex-1 flex flex-col items-center justify-center gap-6 py-20 px-6 text-center">
        <div className="-rotate-2">
          <div className="bg-paper border-2 border-ink rounded-2xl shadow-brutal p-8">
            <h1 className="mako-display text-2xl md:text-3xl mb-3">NOT CONNECTED</h1>
            <p className="mako-body text-muted max-w-xs">
              Connect your wallet to see markets you have a position in.
            </p>
          </div>
        </div>
        {/* Temporary RainbowKit Connect entry point. The full /profile redesign
            in Phase 1E gives this its own polished surface; until then this
            is the only place to wire wagmi up so external-wallet bet flow
            (Phase 1C) is reachable. */}
        <ConnectButton />
        <Link href="/" className="mako-button mako-button--signal mako-label">
          BACK TO FEED
        </Link>
      </main>
    );
  }

  return (
    <main className="flex-1 flex flex-col w-full pb-10">
      <MobileChromeHeader />

      {/* Sticky chrome header — matches the home page's LIVE MARKETS bar
          (h-12, chrome surface, full-width border). Title shifts from
          PORTFOLIO/MY MARKETS double-stack to a single MY MARKETS label. */}
      <header className="hidden md:flex items-center justify-between px-6 lg:px-8 h-12 border-b-2 border-chrome-divider bg-chrome text-chrome-fg sticky top-0 z-30">
        <h1 className="mako-display text-sm lg:text-base text-chrome-fg">MY MARKETS</h1>
        <div className="flex items-center gap-3">
          {user ? (
            <Link
              href="/profile"
              className="flex items-center gap-2 hover:opacity-80 transition-opacity"
              title={getIdentityLabel(user)}
            >
              <AvatarCircle
                displayName={user.displayName}
                initialSource={user.authType === 'magic' ? user.email : user.walletAddress}
                seedKey={user.authType === 'magic' ? user.magicEoa : user.walletAddress}
                avatarUrl={user.avatarUrl}
                size={28}
              />
              <span className="mako-label text-[11px] truncate max-w-[10rem]">
                {getDisplayName(user)}
              </span>
            </Link>
          ) : (
            <span className="mako-mono text-[10px] text-muted">
              {address.slice(0, 6)}…{address.slice(-4)}
            </span>
          )}
          <ThemeToggle />
        </div>
      </header>

      <div className="w-full max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6 md:py-10">
        {/* Mobile-only title — desktop title lives in the sticky header above */}
        <h1 className="md:hidden mako-display text-3xl mb-6 text-canvas-fg">MY MARKETS</h1>

        {/* Tabs */}
        <div className="flex gap-3 mb-8 border-b-2 border-canvas-divider pb-4">
          <button
            type="button"
            onClick={() => setTab('active')}
            aria-current={tab === 'active' ? 'page' : undefined}
            className="mako-label px-4 py-2 rounded-full border-2 border-transparent text-canvas-fg hover:border-canvas-fg aria-[current=page]:border-ink aria-[current=page]:bg-surface-elevated aria-[current=page]:text-ink aria-[current=page]:shadow-[2px_2px_0_0_#D94A3D] transition-all"
          >
            ACTIVE · {active.length}
          </button>
          <button
            type="button"
            onClick={() => setTab('closed')}
            aria-current={tab === 'closed' ? 'page' : undefined}
            className="mako-label px-4 py-2 rounded-full border-2 border-transparent text-canvas-fg hover:border-canvas-fg aria-[current=page]:border-ink aria-[current=page]:bg-surface-elevated aria-[current=page]:text-ink aria-[current=page]:shadow-[2px_2px_0_0_#D94A3D] transition-all"
          >
            CLOSED · {closed.length}
          </button>
        </div>

        {(betsError || anyReadFailed) && (
          <div className="mb-6 bg-mako-red/10 border-2 border-mako-red rounded-xl p-4 text-center">
            <span className="mako-label text-mako-red">
              READ ERROR · SOME POSITIONS MAY BE MISSING · RETRYING…
            </span>
          </div>
        )}

        {(isLoading || isBetsLoading) && userPositions.length === 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="mako-skeleton h-[220px]" aria-hidden="true" />
            ))}
          </div>
        ) : shown.length === 0 ? (
          <div className="rotate-2 transform mt-12 max-w-md mx-auto">
            <div className="bg-paper border-2 border-ink rounded-xl shadow-brutal p-6 text-center">
              <div className="mako-title text-xl mb-2">
                {tab === 'active' ? 'No active positions' : 'No closed positions'}
              </div>
              <div className="mako-body text-muted text-sm">
                {tab === 'active'
                  ? 'Place a bet from the feed to see it here'
                  : 'Your resolved + expired bets will appear here'}
              </div>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {shown.map(({ market }) => {
              const showAdminResolve = isAdmin && tab === 'closed' && !market.resolved;
              const showInlineClaim = tab === 'closed' && market.resolved;

              return (
                <div key={market.id.toString()} className="flex flex-col gap-3">
                  <Link href={`/market/${market.id.toString()}`} className="block">
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
            })}
          </div>
        )}
      </div>
    </main>
  );
}
