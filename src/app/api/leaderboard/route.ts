import { unstable_cache } from 'next/cache';
import { z } from 'zod';

import { db } from '@/db/client';
import { MONAD_TESTNET_ID } from '@/lib/chain';
import { makoLeaderboardIndexerState } from '@/db/schema';
import {
  getLeaderboardRows,
  getCallerRank,
  type LeaderboardOrderBy,
  type LeaderboardRow,
  type LeaderboardWindow,
} from '@/lib/leaderboard/queries';
import { resolveLabels } from '@/lib/leaderboard/identity';
import { LEADERBOARD_CONTRACTS } from '@/lib/leaderboard/contracts';

// ----------------------------------------------------------------------------
// GET /api/leaderboard?window=all|week|month[&sort=profit|volume][&me=0x…]
//
// week = the last 7 days, month = the last 30 days (rolling, no reset).
// sort=profit ranks by NET (the default), sort=volume by STAKED; the
// caller's `viewer` rank always uses the same sort as the board.
//
// Read-only over the mako_market_events ledger. NEVER writes and never
// triggers a scan — the cron at /api/cron/leaderboard is the sole
// writer (run-if-stale was deliberately rejected at plan review). On a
// cold/lagging ledger this serves whatever is indexed plus
// `indexedThrough` + `generatedAt` so the UI can show staleness.
//
// Split-cache design (plan, Codex r1 MAJOR-3):
//   - The top-100 board is a SHARED artifact: unstable_cache keyed by
//     window and sort ONLY (same convention as charts/route.ts),
//     revalidate 45s.
//     Identity labels ride inside the cached board — display-name edits
//     surface within one revalidation window.
//   - The caller's own rank (`viewer`) is PER-USER and never enters the
//     window-keyed cache. It is computed live, and ONLY when `me` is
//     absent from the cached board rows — when the caller is on the
//     board, the board row is the single source of truth (consistency
//     rule: never two ranks for one user in one payload).
//
// `viewer` field semantics:
//   - key absent → caller is on the board (or no `me` was passed);
//   - null      → caller has no events in this window;
//   - object    → caller's off-board row + 1-based rank by the sort.
//
// Every window ranks by NET by default (Joshua's call on plan open-Q2,
// option (a)): the windowed tabs show NET as cash-flow, explained in the
// UI — a claim made this week counts in this week even if the bet was
// staked earlier. The math itself is pinned by queries tests.
// ----------------------------------------------------------------------------

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const REVALIDATE_SECONDS = 45;
const BOARD_LIMIT = 100;

const Query = z.object({
  window: z.enum(['all', 'week', 'month']).default('all'),
  sort: z.enum(['profit', 'volume']).default('profit'),
  me: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
});

export interface LeaderboardBoardRow extends LeaderboardRow {
  /// Resolved display name (safe-account or wallet identity), or null
  /// → UI renders the truncated address.
  displayName: string | null;
}

export interface LeaderboardViewer extends LeaderboardBoardRow {
  rank: number;
}

interface Board {
  rows: LeaderboardBoardRow[];
  /// Lowest last_scanned_block across indexed contracts — the block
  /// height the board is complete up to. Null until the seed has run.
  indexedThrough: number | null;
  /// True while ANY contract is mid-backfill: no cursor rows yet, a
  /// cursor that never completed a scan (target 0), or a cursor behind
  /// its own last scan target. `indexedThrough === null` alone only
  /// covers the seconds between migration and the first lock acquire —
  /// the cursor row is born at acquire with last_scanned_block = 0 and
  /// then climbs for hours during the backfill, so keying the UI's
  /// SYNCING banner off null would present a partial, oldest-events-
  /// first board as authoritative (review MAJOR-1).
  syncing: boolean;
  generatedAt: string;
}

type LeaderboardSort = 'profit' | 'volume';

const ORDER_BY: Record<LeaderboardSort, LeaderboardOrderBy> = {
  profit: 'net',
  volume: 'staked',
};

async function buildBoard(
  window: LeaderboardWindow,
  sort: LeaderboardSort,
): Promise<Board> {
  const rows = await getLeaderboardRows(db, {
    window,
    orderBy: ORDER_BY[sort],
    limit: BOARD_LIMIT,
  });
  const labels = await resolveLabels(
    db,
    rows.map((r) => r.actor),
    MONAD_TESTNET_ID,
  );
  const boardRows: LeaderboardBoardRow[] = rows.map((r) => ({
    ...r,
    displayName: labels.get(r.actor)?.displayName ?? null,
  }));

  // Scope cursor rows to the CONFIGURED contract set on the active
  // chain (re-review, post-fix MAJOR-1 gap): a contract added to
  // LEADERBOARD_CONTRACTS with no cursor row yet means its data is
  // entirely absent — the board must say syncing even though every
  // EXISTING row looks caught up. Symmetrically, rows from removed
  // contracts or other chains must not vouch for this board.
  // Addresses match exactly: contracts.ts lowercases at the boundary
  // and the DB CHECK enforces lowercase on contract_address.
  const cursors = await db.select().from(makoLeaderboardIndexerState);
  const byAddress = new Map(
    cursors
      .filter((c) => c.chainId === MONAD_TESTNET_ID)
      .map((c) => [c.contractAddress, c] as const),
  );
  const tracked = LEADERBOARD_CONTRACTS.map((c) => byAddress.get(c.address));
  const present = tracked.filter(
    (c): c is NonNullable<typeof c> => c !== undefined,
  );
  const indexedThrough =
    present.length === 0
      ? null
      : Math.min(...present.map((c) => c.lastScannedBlock));
  // A completed tick ends with scanned === target exactly (the target
  // is written in the same UPDATE as the final cursor advance), so no
  // slack threshold is needed: behind-target means mid-backfill or a
  // budget-exhausted tick still catching up.
  const syncing =
    present.length < LEADERBOARD_CONTRACTS.length ||
    present.some(
      (c) => c.lastScanTarget === 0 || c.lastScannedBlock < c.lastScanTarget,
    );

  return {
    rows: boardRows,
    indexedThrough,
    syncing,
    generatedAt: new Date().toISOString(),
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const parsed = Query.safeParse({
    window: url.searchParams.get('window') ?? undefined,
    sort: url.searchParams.get('sort') ?? undefined,
    me: url.searchParams.get('me') ?? undefined,
  });
  if (!parsed.success) {
    return Response.json({ error: 'bad_params' }, { status: 400 });
  }
  const { window, sort, me } = parsed.data;

  try {
    // Shared board: cache key carries the window and sort and NOTHING
    // about the caller — per-user data must never poison the shared
    // artifact.
    const cachedBoard = unstable_cache(
      () => buildBoard(window, sort),
      ['leaderboard-board', window, sort],
      { revalidate: REVALIDATE_SECONDS },
    );
    const board = await cachedBoard();

    let viewer: LeaderboardViewer | null | undefined;
    if (me !== undefined) {
      const meLower = me.toLowerCase() as `0x${string}`;
      const onBoard = board.rows.some((r) => r.actor === meLower);
      if (!onBoard) {
        const rank = await getCallerRank(db, {
          window,
          address: meLower,
          orderBy: ORDER_BY[sort],
        });
        if (rank === null) {
          viewer = null;
        } else {
          const labels = await resolveLabels(db, [meLower], MONAD_TESTNET_ID);
          viewer = {
            ...rank.row,
            displayName: labels.get(meLower)?.displayName ?? null,
            rank: rank.rank,
          };
        }
      }
      // onBoard → viewer stays undefined; the board row is the truth.
    }

    return Response.json({
      window,
      sort,
      rows: board.rows,
      ...(viewer !== undefined ? { viewer } : {}),
      indexedThrough: board.indexedThrough,
      syncing: board.syncing,
      generatedAt: board.generatedAt,
    });
  } catch (err) {
    console.error(
      '[api/leaderboard] failed:',
      err instanceof Error ? err.message : String(err),
    );
    return Response.json({ error: 'leaderboard_failed' }, { status: 500 });
  }
}
