import { sql } from 'drizzle-orm';

import { db } from '@/db/client';
import { monadTestnet, MONAD_TESTNET_ID } from '@/lib/chain';
import { ROUNDS_ADDRESS } from '@/lib/contract';
import { checkCronAuth } from '@/lib/cron-auth';
import {
  createScanClient,
  runLeaderboardIndexerOnce,
  ROUTE_HARD_STOP_MS,
  type LeaderboardContractScanResult,
} from '@/lib/leaderboard/indexer';
import { runRoundsScanOnce } from '@/lib/notifications/rounds-scan';

// ----------------------------------------------------------------------------
// GET /api/cron/notify (#214, NOTIFICATIONS_PLAN r8 §3.9). Production: pinged by the mako-auto-resolver Worker at
// minute % 15, the tick that already wakes Neon for aa-fast. Beta: ticked by hand with scripts/notify-tick.mjs.
//
// Steps, in order, each with its own budget and try/catch (S1 runs steps 1, 2 and 6):
//   1. V4 indexer (the leaderboard ledger + pool results), 16 s
//   2. Rounds scan, 12 s
//   6. Prune
// Time limits: one scan client per call; its gate refuses every RPC request after t0 + 48 s and each request times
// out at 5 s, so nothing outside is in flight after 53 s. A step that would begin after 48 s is skipped and reported
// as `skipped: 'time'`; prune runs again next tick. If Vercel kills the function anyway nothing is lost or doubled:
// the cursors move only with their rows, and the lock heals after 5 minutes.
//
// The response holds counts and block numbers only: no account address, email or user id. Each scan reports
// scannedTo, scanTarget, upToDate, noFloor, notifiedThrough and rosterFromChain (§3.9).
// Auth: Bearer CRON_SECRET only (cron-auth.ts).
// ----------------------------------------------------------------------------

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const V4_BUDGET_MS = 16_000;
const ROUNDS_BUDGET_MS = 12_000;
const PRUNE_LIMIT = 1_000;

type ScanReport = Omit<LeaderboardContractScanResult, 'contractAddress'>;

/// The scan result without the contract address, which the tick script does not need.
const report = (r: LeaderboardContractScanResult): ScanReport => {
  const rest: Partial<LeaderboardContractScanResult> = { ...r };
  delete rest.contractAddress;
  return rest as ScanReport;
};

const rowCount = (res: unknown): number => {
  const r = res as { count?: number; affectedRows?: number; rows?: unknown[] };
  return Number(r.count ?? r.affectedRows ?? 0);
};

/// §3.6, limited to what S1 writes: notifications after 90 days, time reminders 7 days after their event, round
/// entrants after 9 days (a round settled later gets its roster from the contract). notify_cursor is never pruned.
async function prune() {
  const notifications = rowCount(
    await db.execute(sql`
      DELETE FROM notifications WHERE id IN (
        SELECT id FROM notifications WHERE created_at < now() - interval '90 days' LIMIT ${PRUNE_LIMIT})`),
  );
  const reminders = rowCount(
    await db.execute(sql`
      DELETE FROM notifications WHERE id IN (
        SELECT id FROM notifications
         WHERE kind IN ('closing', 'round_start') AND event_at < now() - interval '7 days' LIMIT ${PRUNE_LIMIT})`),
  );
  const entrants = rowCount(
    await db.execute(sql`
      DELETE FROM mako_round_entrants WHERE (contract_address, round_id, account) IN (
        SELECT contract_address, round_id, account FROM mako_round_entrants
         WHERE created_at < now() - interval '9 days' LIMIT ${PRUNE_LIMIT})`),
  );
  return { notifications, reminders, entrants };
}

export async function GET(req: Request) {
  if (!checkCronAuth(req)) {
    return Response.json({ error: 'unauthorized' }, { status: 403 });
  }
  const t0 = Date.now();
  const hardStopAt = t0 + ROUTE_HARD_STOP_MS;
  const rpcUrl = process.env.MONAD_RPC_URL || monadTestnet.rpcUrls.default.http[0];
  const publicClient = createScanClient(rpcUrl, hardStopAt);
  const late = () => Date.now() >= hardStopAt;
  const fail = (step: string, err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[cron/notify] ${step} failed: ${message}`);
    return { error: 'step_failed' as const };
  };

  let v4: ScanReport | { skipped: 'time' } | { error: 'step_failed' };
  if (late()) v4 = { skipped: 'time' };
  else {
    try {
      const r = await runLeaderboardIndexerOnce({ db, publicClient, chainId: MONAD_TESTNET_ID, timeBudgetMs: V4_BUDGET_MS, hardStopAt });
      v4 = report(r.contracts[0]);
    } catch (err) {
      v4 = fail('v4', err);
    }
  }

  let rounds: ScanReport | { skipped: 'time' | 'rounds_off' } | { error: 'step_failed' };
  if (late()) rounds = { skipped: 'time' };
  else if (!ROUNDS_ADDRESS) rounds = { skipped: 'rounds_off' };
  else {
    try {
      rounds = report(
        await runRoundsScanOnce({ db, publicClient, contractAddress: ROUNDS_ADDRESS, chainId: MONAD_TESTNET_ID, timeBudgetMs: ROUNDS_BUDGET_MS, hardStopAt }),
      );
    } catch (err) {
      rounds = fail('rounds', err);
    }
  }

  let pruned: Awaited<ReturnType<typeof prune>> | { skipped: 'time' } | { error: 'step_failed' };
  if (late()) pruned = { skipped: 'time' };
  else {
    try {
      pruned = await prune();
    } catch (err) {
      pruned = fail('prune', err);
    }
  }

  return Response.json({ ok: true, v4, rounds, prune: pruned, durationMs: Date.now() - t0 });
}
