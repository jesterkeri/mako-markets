// ----------------------------------------------------------------------------
// price-recorder/src/checker.ts
//
// The production invariant checker (CHARTS_DS_PLAN 3.6): one (feed, UTC day) shard a tick, inside the tick, under the
// lease. A cycle is the materialised list of 34 feeds x 31 days (today - 30 .. today) = 1,054 shards, written with the
// cycle row in the batch of the tick that starts it; the cycle never consults the feed table again.
// Per shard: two reads (the day's 1m rows; its 15m, 1h and 1d rows), then every stored 15m and 1h bucket is recomputed
// from the stored 1m rows and the 1d bucket from the stored 1h rows, and compared.
// The horizon: a stored bucket was computed with the horizon of the tick that last wrote it, which no row records,
// and only n_min_gap depends on it (missing minutes count once elapsed, rollup.ts). So every other field must equal
// the recompute exactly, and n_min_gap must lie between the recompute at the bucket's start (nothing elapsed) and at
// min(bucket end, this tick's horizon) (no writer had a later one).
// Also a diff: an hour with 1m rows but without its 1h row or one of its four 15m rows, and a day with 1h rows but no
// 1d row (every write of an hour writes all five, and every write of a day its 1d row, plan.ts).
// The result row and the cursor go in the tick's one batch; the completion is in the same statement as the cursor and
// needs one stored result per ordinal. A shard that cannot be read or parsed is not advanced and is retried next tick;
// after 10 such ticks running the tick logs `checker_stuck` (alerting: unit f).
// ----------------------------------------------------------------------------

import { keccak256, stringToHex } from 'viem';
import { isInt, parseBucket, parseStoredMinute } from './db';
import { FEEDS } from './feeds';
import { D1_NOW } from './lease';
import { align, bucketFromMinutes, DAY, HOUR, QUARTER, rollupDay, type Bucket, type MinuteCell } from './rollup';

export const CHECKER_VERSION = 'checker-1';
export const CHECKER_DAYS = 31;
export const STUCK_TICKS = 10;

export type OpenCycle = { id: number; total: number; next: number; stuck: number; feed: string | null; day: number | null };


/// The `checker` column of the state read (backfill.ts STATE_SQL): the open cycle and its current shard, or null.
export function parseOpenCycle(json: string | null): OpenCycle | null {
  if (json === null) return null;
  const o = JSON.parse(json) as Record<string, unknown>;
  if (!isInt(o.id) || !isInt(o.total) || !isInt(o.next) || !isInt(o.stuck)) throw new Error('malformed checker cycle');
  const feed = typeof o.feed === 'string' ? o.feed : null;
  const day = isInt(o.day) ? o.day : null;
  return { id: o.id, total: o.total, next: o.next, stuck: o.stuck, feed, day };
}

// ---- starting a cycle ----------------------------------------------------------

/// The cycle id is D1's clock at creation: unique (one cycle at a time, at most one a tick) and never reused after
/// pruning.
export const CYCLE_INSERT_SQL =
  `INSERT INTO checker_cycle (id, started_at, anchor_day, feed_list_json, feed_list_hash, checker_version, shards_total) ` +
  `SELECT ${D1_NOW}, ${D1_NOW}, ?1, ?2, ?3, ?4, ?5 WHERE NOT EXISTS (SELECT 1 FROM checker_cycle WHERE completed_at IS NULL)`;

/// Ordinal = feed index x 31 + day index, days oldest first.
export const SHARDS_INSERT_SQL =
  `WITH RECURSIVE d(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM d WHERE i < ${CHECKER_DAYS - 1}) ` +
  `INSERT INTO checker_shard (cycle_id, ordinal, feed, day) ` +
  `SELECT (SELECT MAX(id) FROM checker_cycle WHERE completed_at IS NULL), f.key * ${CHECKER_DAYS} + d.i, f.value, ?1 - (${CHECKER_DAYS - 1} - d.i) * ${DAY} ` +
  `FROM json_each(?2) f, d WHERE true`;

export function startCycle(db: D1Database, horizon: number, feeds: readonly string[] = FEEDS.map((f) => f.symbol)): D1PreparedStatement[] {
  const anchor = align(horizon - 60, DAY); // the UTC day of the live minute
  const list = JSON.stringify(feeds);
  return [
    db.prepare(CYCLE_INSERT_SQL).bind(anchor, list, keccak256(stringToHex(list)), CHECKER_VERSION, feeds.length * CHECKER_DAYS),
    db.prepare(SHARDS_INSERT_SQL).bind(anchor, list),
  ];
}

// ---- checking a shard ------------------------------------------------------------

export const SHARD_MINUTES_SQL = `SELECT * FROM candles_1m WHERE feed = ?1 AND t >= ?2 AND t < ?2 + ${DAY}`;
export const SHARD_BUCKETS_SQL =
  `SELECT '15m' AS tf, * FROM candles_15m WHERE feed = ?1 AND t >= ?2 AND t < ?2 + ${DAY} ` +
  `UNION ALL SELECT '1h' AS tf, * FROM candles_1h WHERE feed = ?1 AND t >= ?2 AND t < ?2 + ${DAY} ` +
  `UNION ALL SELECT '1d' AS tf, * FROM candles_1d WHERE feed = ?1 AND t = ?2`;

export type ShardResult = { status: 'ok' | 'diff'; n_buckets: number; n_diff: number; first_diff: string | null };

type Tf = '15m' | '1h' | '1d';
const SPAN: Readonly<Record<Tf, number>> = { '15m': QUARTER, '1h': HOUR, '1d': DAY };
const EXACT = ['o', 'h', 'l', 'c', 'n_min_open', 'n_min_closed', 'n_min_retry'] as const;

/// Two reads, then the comparison. Throws when a read fails or a row does not parse (the caller retries the shard).
export async function checkShard(db: D1Database, feed: string, day: number, horizon: number): Promise<ShardResult> {
  const [m, b] = await Promise.all([
    db.prepare(SHARD_MINUTES_SQL).bind(feed, day).all<Record<string, unknown>>(),
    db.prepare(SHARD_BUCKETS_SQL).bind(feed, day).all<Record<string, unknown>>(),
  ]);
  const minutes = m.results.map(parseStoredMinute);
  const stored = b.results.map((r) => {
    const tf = r.tf;
    if (tf !== '15m' && tf !== '1h' && tf !== '1d') throw new Error('malformed bucket tf');
    return { tf: tf as Tf, b: parseBucket(r) };
  });
  return compareShard(feed, day, minutes, stored, horizon);
}

/// Pure: the comparison of one shard (exported for tests).
export function compareShard(
  feed: string,
  day: number,
  minutes: readonly MinuteCell[],
  stored: readonly { tf: Tf; b: Bucket }[],
  horizon: number,
): ShardResult {
  const diffs: { tf: Tf; t: number; field: string; stored: unknown; expected: unknown }[] = [];
  const hours = stored.filter((s) => s.tf === '1h').map((s) => s.b);
  const recompute = (tf: Tf, t: number, h: number): Bucket =>
    tf === '1d' ? rollupDay(feed, t, hours, h) : bucketFromMinutes(feed, t, SPAN[tf], minutes, h);

  for (const { tf, b } of stored) {
    const end = b.t + SPAN[tf];
    const low = recompute(tf, b.t, b.t);
    const high = recompute(tf, b.t, Math.min(end, horizon));
    for (const k of EXACT) if (b[k] !== low[k]) diffs.push({ tf, t: b.t, field: k, stored: b[k], expected: low[k] });
    if (b.n_min_gap < low.n_min_gap || b.n_min_gap > high.n_min_gap) diffs.push({ tf, t: b.t, field: 'n_min_gap', stored: b.n_min_gap, expected: [low.n_min_gap, high.n_min_gap] });
  }

  // Buckets every write produces must exist.
  const have = new Set(stored.map((s) => `${s.tf}:${s.b.t}`));
  for (const h of new Set(minutes.map((x) => align(x.t, HOUR)))) {
    if (!have.has(`1h:${h}`)) diffs.push({ tf: '1h', t: h, field: 'missing', stored: null, expected: 'row' });
    for (let q = h; q < h + HOUR; q += QUARTER) if (!have.has(`15m:${q}`)) diffs.push({ tf: '15m', t: q, field: 'missing', stored: null, expected: 'row' });
  }
  if (hours.length > 0 && !have.has(`1d:${day}`)) diffs.push({ tf: '1d', t: day, field: 'missing', stored: null, expected: 'row' });

  const first = diffs[0];
  return {
    status: diffs.length === 0 ? 'ok' : 'diff',
    n_buckets: stored.length,
    n_diff: diffs.length,
    first_diff: first ? JSON.stringify(first) : null,
  };
}

// ---- recording the result -----------------------------------------------------------

/// The result row, with feed and day copied from the stored shard; written only while the cursor is where it was read.
export const RESULT_INSERT_SQL =
  `INSERT INTO checker_result (cycle_id, ordinal, feed, day, status, n_buckets, n_diff, first_diff) ` +
  `SELECT c.id, c.next_index, s.feed, s.day, ?3, ?4, ?5, ?6 FROM checker_cycle c ` +
  `JOIN checker_shard s ON s.cycle_id = c.id AND s.ordinal = c.next_index WHERE c.id = ?1 AND c.next_index = ?2`;

/// The cursor, the counters and, on the last ordinal, the completion: only when every ordinal has its stored result.
export const CURSOR_UPDATE_SQL =
  `UPDATE checker_cycle SET next_index = next_index + 1, n_ok = n_ok + ?3, n_diff = n_diff + ?4, stuck = 0, ` +
  `completed_at = CASE WHEN next_index + 1 >= shards_total AND (SELECT COUNT(*) FROM checker_result r WHERE r.cycle_id = ?1) = shards_total ` +
  `THEN ${D1_NOW} ELSE NULL END WHERE id = ?1 AND next_index = ?2 AND completed_at IS NULL`;

export const STUCK_UPDATE_SQL = `UPDATE checker_cycle SET stuck = stuck + 1 WHERE id = ?1 AND completed_at IS NULL`;

export function resultWrites(db: D1Database, c: OpenCycle, r: ShardResult): D1PreparedStatement[] {
  return [
    db.prepare(RESULT_INSERT_SQL).bind(c.id, c.next, r.status, r.n_buckets, r.n_diff, r.first_diff),
    db.prepare(CURSOR_UPDATE_SQL).bind(c.id, c.next, r.status === 'ok' ? 1 : 0, r.status === 'diff' ? 1 : 0),
  ];
}

export const stuckWrite = (db: D1Database, c: OpenCycle): D1PreparedStatement => db.prepare(STUCK_UPDATE_SQL).bind(c.id);

/// The tick's checker step (3.6): start a cycle when none is open, else check the current shard. Read in the tick's
/// read phase, so its reads never meet the batch deadline; returns the statements for the tick's one batch. A read or
/// parse failure of the shard is not a result: the shard stays where it is, its stuck count goes up, and it is retried
/// next tick. A malformed open-cycle row (`parseOpenCycle`) throws to the caller, failing the whole tick.
export async function checkerStep(db: D1Database, openCycle: string | null, horizon: number, log: (e: Record<string, unknown>) => void): Promise<D1PreparedStatement[]> {
  const cycle = parseOpenCycle(openCycle);
  if (cycle === null) return startCycle(db, horizon);
  if (cycle.feed !== null && cycle.day !== null) {
    try {
      const r = await checkShard(db, cycle.feed, cycle.day, horizon);
      if (r.status === 'diff') log({ event: 'checker_diff', cycle: cycle.id, ordinal: cycle.next, feed: cycle.feed, day: cycle.day, first: r.first_diff });
      return resultWrites(db, cycle, r);
    } catch (e) {
      log({ event: 'checker_read_failed', cycle: cycle.id, ordinal: cycle.next, error: e instanceof Error ? e.name : 'error' });
    }
  }
  if (cycle.stuck + 1 >= STUCK_TICKS) log({ event: 'checker_stuck', cycle: cycle.id, ordinal: cycle.next, ticks: cycle.stuck + 1 });
  return [stuckWrite(db, cycle)];
}
