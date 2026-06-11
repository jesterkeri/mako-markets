import { unstable_cache } from 'next/cache';
import { z } from 'zod';

import { db } from '@/db/client';
import { MONAD_TESTNET_ID } from '@/lib/chain';
import { makoLeaderboardIndexerState } from '@/db/schema';
import {
  getLeaderboardRows,
  getCallerRank,
  type LeaderboardRow,
  type LeaderboardWindow,
} from '@/lib/leaderboard/queries';
import { resolveLabels } from '@/lib/leaderboard/identity';

// ----------------------------------------------------------------------------
// GET /api/leaderboard?window=all|week[&me=0x…]
//
// Read-only over the mako_market_events ledger. NEVER writes and never
// triggers a scan — the cron at /api/cron/leaderboard is the sole
// writer (run-if-stale was deliberately rejected at plan review). On a
// cold/lagging ledger this serves whatever is indexed plus
// `indexedThrough` + `generatedAt` so the UI can show staleness.
//
// Split-cache design (plan, Codex r1 MAJOR-3):
//   - The top-100 board is a SHARED artifact: unstable_cache keyed by
//     window ONLY (same convention as charts/route.ts), revalidate 45s.
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
//   - object    → caller's off-board row + 1-based rank by NET.
//
// Both windows rank by NET (Joshua's call on plan open-Q2, option (a)):
// the weekly tab shows NET as cash-flow with an explanatory caption in
// the UI — a claim made this week counts in this week even if the bet
// was staked earlier. The math itself is pinned by queries tests.
// ----------------------------------------------------------------------------

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const REVALIDATE_SECONDS = 45;
const BOARD_LIMIT = 100;

const Query = z.object({
  window: z.enum(['all', 'week']).default('all'),
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

async function buildBoard(window: LeaderboardWindow): Promise<Board> {
  const rows = await getLeaderboardRows(db, { window, limit: BOARD_LIMIT });
  const labels = await resolveLabels(
    db,
    rows.map((r) => r.actor),
    MONAD_TESTNET_ID,
  );
  const boardRows: LeaderboardBoardRow[] = rows.map((r) => ({
    ...r,
    displayName: labels.get(r.actor)?.displayName ?? null,
  }));

  const cursors = await db.select().from(makoLeaderboardIndexerState);
  const indexedThrough =
    cursors.length === 0
      ? null
      : Math.min(...cursors.map((c) => c.lastScannedBlock));
  // A completed tick ends with scanned === target exactly (the target
  // is written in the same UPDATE as the final cursor advance), so no
  // slack threshold is needed: behind-target means mid-backfill or a
  // budget-exhausted tick still catching up.
  const syncing =
    cursors.length === 0 ||
    cursors.some(
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
    me: url.searchParams.get('me') ?? undefined,
  });
  if (!parsed.success) {
    return Response.json({ error: 'bad_params' }, { status: 400 });
  }
  const { window, me } = parsed.data;

  try {
    // Shared board: cache key carries the window and NOTHING about the
    // caller — per-user data must never poison the shared artifact.
    const cachedBoard = unstable_cache(
      () => buildBoard(window),
      ['leaderboard-board', window],
      { revalidate: REVALIDATE_SECONDS },
    );
    const board = await cachedBoard();

    let viewer: LeaderboardViewer | null | undefined;
    if (me !== undefined) {
      const meLower = me.toLowerCase() as `0x${string}`;
      const onBoard = board.rows.some((r) => r.actor === meLower);
      if (!onBoard) {
        const rank = await getCallerRank(db, { window, address: meLower });
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
