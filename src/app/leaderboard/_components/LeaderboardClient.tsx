'use client';

// ----------------------------------------------------------------------------
// #186 Leaderboard — client body.
//
// Tabs: ALL-TIME and THIS WEEK, both ranked by NET (Joshua's open-Q2
// call, option a) — the weekly tab shows NET as cash-flow with the
// caption below the tabs, because a claim made this week counts in this
// week even when the bet was staked earlier.
//
// Identity: display name where known (resolved server-side via the
// safe/wallet dual join), truncated address + explorer link otherwise.
// display_name is non-unique → when a rendered name repeats on the
// board, a short address suffix disambiguates (plan, Codex r1 MINOR-3).
//
// Viewer pin: the API returns `viewer` ONLY when the caller is absent
// from the cached board (consistency rule — never two ranks for one
// user). On-board callers get their row highlighted instead.
//
// Colors follow the chart precedent: positive PnL = ink, negative =
// mako-red. The brand deliberately dropped green; do not reintroduce.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { useAccount } from 'wagmi';

import { useUser } from '@/lib/use-user';
import {
  useLeaderboard,
  type LeaderboardWindow,
  type LeaderboardWireRow,
  type LeaderboardWireViewer,
} from '@/lib/use-leaderboard';
import { formatUsdc } from '@/lib/usdc';
import { explorerAddress } from '@/components/admin-shared';

const TABS: Array<{ key: LeaderboardWindow; label: string }> = [
  { key: 'all', label: 'ALL-TIME' },
  { key: 'week', label: 'THIS WEEK' },
];

function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/// NET renders signed: ink for >= 0, mako-red for < 0 (chart precedent;
/// no green in the palette).
function formatNet(net: string): { text: string; negative: boolean } {
  const v = BigInt(net);
  if (v < 0n) return { text: `−${formatUsdc(-v)}`, negative: true };
  if (v === 0n) return { text: formatUsdc(0n), negative: false };
  return { text: `+${formatUsdc(v)}`, negative: false };
}

/// Names are non-unique; suffix repeats so rankings stay unambiguous.
function buildNameRenderer(
  rows: LeaderboardWireRow[],
  viewer: LeaderboardWireViewer | null | undefined,
) {
  const counts = new Map<string, number>();
  const bump = (n: string | null) => {
    if (n) counts.set(n, (counts.get(n) ?? 0) + 1);
  };
  for (const r of rows) bump(r.displayName);
  if (viewer) bump(viewer.displayName);

  return (row: LeaderboardWireRow): string => {
    if (!row.displayName) return short(row.actor);
    return (counts.get(row.displayName) ?? 0) > 1
      ? `${row.displayName} · ${row.actor.slice(0, 6)}`
      : row.displayName;
  };
}

export default function LeaderboardClient() {
  const [window, setWindow] = useState<LeaderboardWindow>('all');

  // Same on-chain-identity derivation as /me: Magic users bet through
  // their derived Safe; wallet users through the connected wallet.
  const { address: connectedWallet } = useAccount();
  const { user } = useUser();
  const me =
    user?.authType === 'magic'
      ? (user.safeAddress as `0x${string}`)
      : connectedWallet;
  const meLower = me?.toLowerCase();

  const { data, isLoading, isError, refetch } = useLeaderboard(window, me);

  const renderName = useMemo(
    () => buildNameRenderer(data?.rows ?? [], data?.viewer),
    [data],
  );

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 md:px-8">
      <h1 className="mako-display text-3xl md:text-4xl mb-2">LEADERBOARD</h1>
      <p className="mako-body text-sm opacity-70 mb-6">
        PnL counts claimed winnings and refunds. Unclaimed payouts aren&apos;t
        included yet.
      </p>

      {/* Window tabs — segmented pill, admin/charts pattern. */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setWindow(tab.key)}
            className={`mako-label px-4 py-2 rounded-full border-2 border-ink transition-all whitespace-nowrap ${
              window === tab.key
                ? 'bg-ink text-paper shadow-[4px_4px_0_0_#D94A3D]'
                : 'bg-paper text-ink shadow-brutal-sm hover:-translate-y-0.5'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {window === 'week' ? (
        <p className="mako-body text-xs opacity-70 mb-4">
          Net cash-flow this week: counts bets placed and winnings claimed in
          the last 7 days. Claiming an older win shows here too.
        </p>
      ) : (
        <div className="mb-4" />
      )}

      {isLoading ? <SkeletonTable /> : null}

      {isError ? (
        <div className="border-2 border-ink rounded-2xl bg-paper text-ink p-6 shadow-brutal">
          <p className="mako-label mb-2">COULDN&apos;T LOAD THE BOARD</p>
          <button
            type="button"
            onClick={() => refetch()}
            className="mako-button bg-ink text-paper px-4 py-2"
          >
            RETRY
          </button>
        </div>
      ) : null}

      {data ? (
        <>
          {data.syncing ? (
            <div className="border-2 border-ink rounded-2xl bg-signal text-ink p-4 shadow-brutal-sm mb-4">
              <p className="mako-label text-sm">
                SYNCING MARKET HISTORY — standings below are partial until
                indexing completes.
              </p>
            </div>
          ) : null}

          {data.rows.length === 0 && !data.syncing ? (
            <div className="border-2 border-ink rounded-2xl bg-paper text-ink p-6 shadow-brutal">
              <p className="mako-label">
                {window === 'week'
                  ? 'NO ACTIVITY THIS WEEK YET.'
                  : 'NO BETS ON THE BOOKS YET.'}
              </p>
            </div>
          ) : null}

          {data.rows.length > 0 ? (
            <div className="border-2 border-ink rounded-2xl bg-paper text-ink shadow-brutal overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b-2 border-ink">
                    <th className="mako-label text-xs px-4 py-3">RANK</th>
                    <th className="mako-label text-xs px-4 py-3">USER</th>
                    <th className="mako-label text-xs px-4 py-3 text-right">
                      STAKED
                    </th>
                    <th className="mako-label text-xs px-4 py-3 text-right">
                      WON
                    </th>
                    <th className="mako-label text-xs px-4 py-3 text-right">
                      NET PNL
                    </th>
                    <th className="mako-label text-xs px-4 py-3 text-right">
                      BETS
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row, i) => (
                    <BoardRow
                      key={row.actor}
                      row={row}
                      rank={i + 1}
                      isMe={row.actor === meLower}
                      name={renderName(row)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {data.viewer ? (
            <div className="mt-4 border-2 border-ink rounded-2xl bg-paper text-ink shadow-brutal overflow-x-auto">
              <div className="px-4 pt-3">
                <span className="mako-label text-xs bg-signal px-2 py-1 border-2 border-ink rounded-full">
                  YOUR RANK
                </span>
              </div>
              <table className="w-full text-left">
                <tbody>
                  <BoardRow
                    row={data.viewer}
                    rank={data.viewer.rank}
                    isMe
                    name={renderName(data.viewer)}
                  />
                </tbody>
              </table>
            </div>
          ) : null}

          <p className="mako-mono text-xs opacity-60 mt-4">
            {data.indexedThrough !== null
              ? `indexed to block ${data.indexedThrough} · `
              : ''}
            updated {new Date(data.generatedAt).toLocaleTimeString()}
          </p>
        </>
      ) : null}
    </div>
  );
}

function BoardRow({
  row,
  rank,
  isMe,
  name,
}: {
  row: LeaderboardWireRow;
  rank: number;
  isMe: boolean;
  name: string;
}) {
  const net = formatNet(row.net);
  return (
    <tr
      className={`border-b border-ink/20 last:border-b-0 ${
        isMe ? 'bg-signal/30' : ''
      }`}
    >
      <td className="px-4 py-3">
        {rank === 1 ? (
          <span className="mako-label text-sm bg-signal px-2 py-1 border-2 border-ink rounded-full">
            #1
          </span>
        ) : (
          <span className="mako-label text-sm opacity-70">#{rank}</span>
        )}
      </td>
      <td className="px-4 py-3">
        <a
          href={explorerAddress(row.actor)}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:underline"
        >
          <span className="mako-body font-bold">{name}</span>
          {isMe ? (
            <span className="mako-label text-[10px] ml-2 bg-ink text-paper px-1.5 py-0.5 rounded-full">
              YOU
            </span>
          ) : null}
        </a>
      </td>
      <td className="mako-mono px-4 py-3 text-right">
        {formatUsdc(BigInt(row.staked))}
      </td>
      <td className="mako-mono px-4 py-3 text-right">
        {formatUsdc(BigInt(row.won))}
      </td>
      <td
        className={`mako-mono px-4 py-3 text-right font-bold ${
          net.negative ? 'text-mako-red' : ''
        }`}
      >
        {net.text}
      </td>
      <td className="mako-mono px-4 py-3 text-right">{row.bets}</td>
    </tr>
  );
}

function SkeletonTable() {
  return (
    <div className="border-2 border-ink rounded-2xl bg-paper p-4 shadow-brutal flex flex-col gap-3">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="mako-skeleton h-8 w-full rounded" />
      ))}
    </div>
  );
}
