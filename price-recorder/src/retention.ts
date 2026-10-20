// ----------------------------------------------------------------------------
// price-recorder/src/retention.ts
//
// Retention (CHARTS_DS_PLAN 5.3, 3.5, 3.6, 5.2). Pure: which table the hourly pruning statement works on, and its
// cutoff. The SQL is in db.ts.
//   * 1m kept 35 days (covers the 30-day window that can still be repaired from Chainlink); 15m kept 120 days; 1h
//     and 1d kept indefinitely; `runs` 7 days; checker shards and results pruned with their cycle 7 days after it
//     completed (a cycle that has not completed is never pruned); `conflicts` (evidence) and `feed_holds` are never
//     pruned by code.
//   * Pruning runs once an hour, deleting at most 5,000 rows, as ONE statement: the tick budget (plan 4.2, 3.6)
//     counts one pruning statement on the hourly tick. So each hourly tick prunes one table: candles_1m on even UTC
//     hours, and the others in turn on odd hours (each every 10 hours). Steady-state production per table between
//     two of its turns stays far below 5,000 rows (test/retention.test.ts), so the backlog never grows.
//   * Invariant (plan 3.5, sweep C): no writer recomputes a bucket older than 30 days (plan 6), while 1m rows live
//     35 days, so a recompute never sees a pruned minute as missing.
// ----------------------------------------------------------------------------

import { DAY, HOUR } from './rollup';

export const KEEP_1M_S = 35 * DAY;
export const KEEP_15M_S = 120 * DAY;
export const KEEP_RUNS_S = 7 * DAY;
export const KEEP_CHECKER_S = 7 * DAY;
/// Plan 6: backfill and the gap scan take hours in [now - 30 d + 1 h, now - 15 min]; live catch-up the last 10
/// minutes. No writer touches an older minute, so no bucket older than this is ever recomputed.
export const REPAIR_HORIZON_S = 30 * DAY;
export const PRUNE_BATCH = 5000;

export type PruneTarget = 'candles_1m' | 'candles_15m' | 'runs' | 'checker_result' | 'checker_shard' | 'checker_cycle';

/// Odd-hour rotation. checker_cycle comes after its shards and results, and its statement deletes only a cycle that
/// has neither left.
export const ODD_ROTATION: readonly PruneTarget[] = ['candles_15m', 'runs', 'checker_result', 'checker_shard', 'checker_cycle'];

export function pruneTarget(nowS: number): PruneTarget {
  const n = Math.floor(nowS / HOUR);
  return n % 2 === 0 ? 'candles_1m' : ODD_ROTATION[((n - 1) / 2) % ODD_ROTATION.length];
}

/// Rows strictly older than the cutoff go (for the checker tables: cycles completed before it).
export function pruneCutoff(target: PruneTarget, nowS: number): number {
  switch (target) {
    case 'candles_1m':
      return nowS - KEEP_1M_S;
    case 'candles_15m':
      return nowS - KEEP_15M_S;
    case 'runs':
      return nowS - KEEP_RUNS_S;
    case 'checker_result':
    case 'checker_shard':
    case 'checker_cycle':
      return nowS - KEEP_CHECKER_S;
  }
}
