import { createPublicClient, http } from 'viem';

import { db } from '@/db/client';
import { monadTestnet, MONAD_TESTNET_ID } from '@/lib/chain';
import { checkCronAuth, cronDiagnostics } from '@/lib/cron-auth';
import {
  runLeaderboardIndexerOnce,
  LEADERBOARD_CRON_TIME_BUDGET_MS,
} from '@/lib/leaderboard/indexer';

// ----------------------------------------------------------------------------
// GET /api/cron/leaderboard (every 5 minutes, fired by mako-auto-resolver
// CF Worker — see cf-worker/src/index.ts, minute % 5 gate)
//
// Runs runLeaderboardIndexerOnce against the LEADERBOARD_CONTRACTS list.
// Per-contract mutex serialises overlapping ticks; busy contracts return
// in the result as mutex:'busy' (NOT a 5xx — busy is healthy).
//
// This is the ONLY writer to mako_market_events. /api/leaderboard reads
// the ledger and never triggers a scan (run-if-stale was deliberately
// rejected: read paths that write are a serverless foot-gun — thundering
// herd on cache expiry, p99 = full scan, lock held across a timeout).
//
// COLD START: this route cannot backfill from the deploy block (millions
// of blocks). scripts/seed-leaderboard.mts does that, locally, BEFORE
// this cron is wired (seed first, then wrangler deploy — if the cron
// deploys first, a tick grabs the per-contract lock and the slow
// killed-and-resumed serverless path does the backfill instead of the
// fast uncontended local script). Steady state here is a few hundred
// blocks per tick.
//
// Lock/timeout ordering: maxDuration below MUST stay equal to
// LEADERBOARD_CRON_MAX_DURATION_S, and LEADERBOARD_STALE_LOCK_MS must
// exceed it — both pinned by __tests__/indexer.test.ts (it reads this
// file's literal). The runner additionally stops starting new chunks at
// LEADERBOARD_CRON_TIME_BUDGET_MS so a healthy tick releases its lock
// cleanly instead of being killed at maxDuration.
//
// CHANGING CONFIRMATIONS LATER: raising it (e.g. 16 → 50) does NOT
// re-validate blocks that were indexed at the lower depth. That requires
// the re-sync runbook: TRUNCATE mako_market_events,
// mako_leaderboard_indexer_state; re-run scripts/seed-leaderboard.mts.
//
// Auth: Bearer-only. See cron-auth.ts.
// ----------------------------------------------------------------------------

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Next requires a static literal here. Must equal
// LEADERBOARD_CRON_MAX_DURATION_S in src/lib/leaderboard/indexer.ts —
// the constant-relationship test parses this file and fails on drift.
export const maxDuration = 60;

export async function GET(req: Request) {
  if (!checkCronAuth(req)) {
    return Response.json({ error: 'unauthorized' }, { status: 403 });
  }
  const diagnostics = cronDiagnostics(req);

  const rpcUrl =
    process.env.MONAD_RPC_URL || monadTestnet.rpcUrls.default.http[0];
  const publicClient = createPublicClient({
    chain: monadTestnet,
    transport: http(rpcUrl),
  });

  const startedAt = Date.now();
  try {
    const result = await runLeaderboardIndexerOnce({
      db,
      publicClient,
      chainId: MONAD_TESTNET_ID,
      timeBudgetMs: LEADERBOARD_CRON_TIME_BUDGET_MS,
    });

    return Response.json({
      ok: true,
      status: 'processed',
      chainId: result.chainId,
      contracts: result.contracts,
      durationMs: Date.now() - startedAt,
      diagnostics,
    });
  } catch (err) {
    console.error(
      '[cron/leaderboard] tick failed:',
      err instanceof Error ? err.message : String(err),
    );
    return Response.json(
      { error: 'leaderboard-cron-failed' },
      { status: 500 },
    );
  }
}
