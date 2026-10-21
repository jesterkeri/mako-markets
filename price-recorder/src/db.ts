// ----------------------------------------------------------------------------
// price-recorder/src/db.ts
//
// D1 access for candles, rollups, conflicts and retention (CHARTS_DS_PLAN 4.2, 5.2, 5.3). The logic lives in pure
// modules (merge.ts, plan.ts, rollup.ts, retention.ts); this file only moves rows.
//   * Reads (plan 4.2 step 4): ONE statement each, with the touched set as one JSON parameter through json_each, so
//     the number of statements does not grow with the set. Every row read is checked field by field; a row that does
//     not have the stored shape throws (the tick then writes nothing, which is the fail-closed outcome).
//   * Writes (plan 4.2 step 6): statements only, never executed here, so the tick can put them in its one batch
//     between the lease fence and the release. Each upsert is a single statement whose rows arrive as one JSON text
//     parameter. An empty set produces no statement.
//   * Retention: the one hourly pruning statement (retention.ts).
// ----------------------------------------------------------------------------

import type { ConflictEvidence, StoredMinute } from './merge';
import type { Span, TickPlan } from './plan';
import { pruneCutoff, pruneTarget, PRUNE_BATCH, type PruneTarget } from './retention';
import type { Bucket } from './rollup';

export type BucketTable = 'candles_15m' | 'candles_1h' | 'candles_1d';

const MINUTE_COLS = ['feed', 't', 'state', 'o', 'h', 'l', 'c', 'n_reports', 'n_open', 'n_rejected', 'open_obs', 'close_obs', 'max_stale_s', 'fp', 'n_valid', 'raw_fp', 'n_raw', 'raw_rule', 'rules_version', 'tries'] as const;
const BUCKET_COLS = ['feed', 't', 'o', 'h', 'l', 'c', 'n_min_open', 'n_min_closed', 'n_min_gap', 'n_min_retry'] as const;
const CONFLICT_COLS = ['feed', 'kind', 'minute', 'obs', 'keccak_a', 'keccak_b', 'fp_old', 'fp_new', 'n_valid_old', 'n_valid_new', 'raw_fp_old', 'raw_fp_new', 'n_raw_old', 'n_raw_new', 'rules_version_old', 'rules_version_new'] as const;
const STATES: ReadonlySet<string> = new Set(['open', 'closed', 'unknown', 'stale', 'empty', 'incomplete', 'conflict']);

const D1_NOW = "CAST(strftime('%s', 'now') AS INTEGER)";

// ---- row shapes --------------------------------------------------------------

const fail = (what: string, row: unknown): never => {
  throw new Error(`malformed ${what} row: ${JSON.stringify(row)}`);
};
export const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const isText = (v: unknown): v is string => typeof v === 'string';
const isPrice = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v);
const intOrNull = (v: unknown): v is number | null => v === null || isInt(v);
const textOrNull = (v: unknown): v is string | null => v === null || isText(v);
const priceOrNull = (v: unknown): v is string | null => v === null || isPrice(v);

export function parseStoredMinute(r: Record<string, unknown>): StoredMinute {
  const ok =
    isText(r.feed) && isInt(r.t) && isText(r.state) && STATES.has(r.state) &&
    priceOrNull(r.o) && priceOrNull(r.h) && priceOrNull(r.l) && priceOrNull(r.c) &&
    isInt(r.n_reports) && isInt(r.n_open) && isInt(r.n_rejected) && intOrNull(r.open_obs) && intOrNull(r.close_obs) &&
    intOrNull(r.max_stale_s) && textOrNull(r.fp) && isInt(r.n_valid) && textOrNull(r.raw_fp) && isInt(r.n_raw) &&
    isInt(r.raw_rule) && isText(r.rules_version) && isInt(r.tries);
  if (!ok) return fail('candles_1m', r);
  const out = Object.fromEntries(MINUTE_COLS.map((k) => [k, r[k]])) as StoredMinute;
  if ((out.state === 'open') !== (out.o !== null && out.h !== null && out.l !== null && out.c !== null)) return fail('candles_1m', r);
  return out;
}

export function parseBucket(r: Record<string, unknown>): Bucket {
  const ok =
    isText(r.feed) && isInt(r.t) && priceOrNull(r.o) && priceOrNull(r.h) && priceOrNull(r.l) && priceOrNull(r.c) &&
    isInt(r.n_min_open) && isInt(r.n_min_closed) && isInt(r.n_min_gap) && isInt(r.n_min_retry);
  if (!ok) return fail('bucket', r);
  return Object.fromEntries(BUCKET_COLS.map((k) => [k, r[k]])) as Bucket;
}

// ---- reads (plan 4.2 step 4) -------------------------------------------------

const spansJson = (spans: readonly Span[]) => JSON.stringify(spans.map((s) => ({ feed: s.feed, start: s.start })));

/// Every stored 1m row of every (feed, hour) in `hours`: one statement.
export const READ_MINUTES_SQL =
  `SELECT m.* FROM json_each(?1) j JOIN candles_1m m ON m.feed = json_extract(j.value, '$.feed') ` +
  `AND m.t >= json_extract(j.value, '$.start') AND m.t < json_extract(j.value, '$.start') + 3600`;

/// Every stored 1h row of every (feed, day) in `days`: one statement.
export const READ_HOURS_SQL =
  `SELECT b.* FROM json_each(?1) j JOIN candles_1h b ON b.feed = json_extract(j.value, '$.feed') ` +
  `AND b.t >= json_extract(j.value, '$.start') AND b.t < json_extract(j.value, '$.start') + 86400`;

export async function readMinutesOfHours(db: D1Database, hours: readonly Span[]): Promise<StoredMinute[]> {
  if (hours.length === 0) return [];
  const res = await db.prepare(READ_MINUTES_SQL).bind(spansJson(hours)).all<Record<string, unknown>>();
  return res.results.map(parseStoredMinute);
}

export async function readHoursOfDays(db: D1Database, days: readonly Span[]): Promise<Bucket[]> {
  if (days.length === 0) return [];
  const res = await db.prepare(READ_HOURS_SQL).bind(spansJson(days)).all<Record<string, unknown>>();
  return res.results.map(parseBucket);
}

// ---- writes (plan 4.2 step 6) ------------------------------------------------

function upsertSql(table: string, cols: readonly string[]): string {
  const pick = cols.map((c) => `json_extract(value, '$.${c}')`).join(', ');
  const set = cols.filter((c) => c !== 'feed' && c !== 't').map((c) => `${c} = excluded.${c}`).join(', ');
  return `INSERT INTO ${table} (${cols.join(', ')}) SELECT ${pick} FROM json_each(?1) WHERE true ON CONFLICT(feed, t) DO UPDATE SET ${set}`;
}

export const UPSERT_MINUTES_SQL = upsertSql('candles_1m', MINUTE_COLS);
export const upsertBucketsSql = (table: BucketTable) => upsertSql(table, BUCKET_COLS);

const rowsJson = (rows: readonly object[], cols: readonly string[]) =>
  JSON.stringify(rows.map((r) => Object.fromEntries(cols.map((c) => [c, (r as Record<string, unknown>)[c] ?? null]))));

export const upsertMinutes = (db: D1Database, rows: readonly StoredMinute[]): D1PreparedStatement | null =>
  rows.length === 0 ? null : db.prepare(UPSERT_MINUTES_SQL).bind(rowsJson(rows, MINUTE_COLS));

export const upsertBuckets = (db: D1Database, table: BucketTable, rows: readonly Bucket[]): D1PreparedStatement | null =>
  rows.length === 0 ? null : db.prepare(upsertBucketsSql(table)).bind(rowsJson(rows, BUCKET_COLS));

/// Evidence is a set: an element already stored (every field but seen_at equal) is not inserted again, so a minute
/// re-fetched by a re-queued hour does not grow the table. `conflicts` has no index (plan 5.2) and holds only real
/// contradictions, so the NOT EXISTS scan stays small.
export const INSERT_CONFLICTS_SQL =
  `INSERT INTO conflicts (${CONFLICT_COLS.join(', ')}, seen_at) SELECT ${CONFLICT_COLS.map((c) => `json_extract(j.value, '$.${c}')`).join(', ')}, ${D1_NOW} ` +
  `FROM json_each(?1) j WHERE NOT EXISTS (SELECT 1 FROM conflicts x WHERE ` +
  CONFLICT_COLS.map((c) => `x.${c} IS json_extract(j.value, '$.${c}')`).join(' AND ') +
  `)`;

/// Identical elements inside one statement are collapsed first: the NOT EXISTS above does not see rows the same
/// statement inserts.
export function insertConflicts(db: D1Database, ev: readonly ConflictEvidence[]): D1PreparedStatement | null {
  if (ev.length === 0) return null;
  const unique = [...new Map(ev.map((e) => [JSON.stringify(CONFLICT_COLS.map((c) => e[c])), e])).values()];
  return db.prepare(INSERT_CONFLICTS_SQL).bind(rowsJson(unique, CONFLICT_COLS));
}

/// Everything a tick's plan writes for candles, in order: 1m, 15m, 1h, 1d, conflicts. Only non-empty sets give a
/// statement, so a tick without conflict evidence has at most four.
export function candleWrites(db: D1Database, plan: TickPlan): D1PreparedStatement[] {
  return [
    upsertMinutes(db, plan.minutes),
    upsertBuckets(db, 'candles_15m', plan.quarters),
    upsertBuckets(db, 'candles_1h', plan.hours),
    upsertBuckets(db, 'candles_1d', plan.days),
    insertConflicts(db, plan.evidence),
  ].filter((s): s is D1PreparedStatement => s !== null);
}

// ---- retention (plan 5.3) ------------------------------------------------------

/// Candle tables are pruned per feed through the primary key (feed, t), with the feed list taken from the small 1d
/// table (every feed with 1m or 15m rows has 1d rows, written in the same batch), so no statement scans a whole
/// candle table.
const candlePrune = (table: 'candles_1m' | 'candles_15m') =>
  `DELETE FROM ${table} WHERE (feed, t) IN (SELECT m.feed, m.t FROM (SELECT DISTINCT feed FROM candles_1d) f ` +
  `JOIN ${table} m ON m.feed = f.feed AND m.t < ?1 LIMIT ${PRUNE_BATCH})`;

const finished = `SELECT id FROM checker_cycle WHERE completed_at IS NOT NULL AND completed_at < ?1`;

export const PRUNE_SQL: Readonly<Record<PruneTarget, string>> = {
  candles_1m: candlePrune('candles_1m'),
  candles_15m: candlePrune('candles_15m'),
  runs: `DELETE FROM runs WHERE t IN (SELECT t FROM runs WHERE t < ?1 LIMIT ${PRUNE_BATCH})`,
  live_stats: `DELETE FROM live_stats WHERE (feed, hour) IN (SELECT feed, hour FROM live_stats WHERE hour < ?1 LIMIT ${PRUNE_BATCH})`,
  checker_result: `DELETE FROM checker_result WHERE (cycle_id, ordinal) IN (SELECT cycle_id, ordinal FROM checker_result WHERE cycle_id IN (${finished}) LIMIT ${PRUNE_BATCH})`,
  checker_shard: `DELETE FROM checker_shard WHERE (cycle_id, ordinal) IN (SELECT cycle_id, ordinal FROM checker_shard WHERE cycle_id IN (${finished}) LIMIT ${PRUNE_BATCH})`,
  checker_cycle:
    `DELETE FROM checker_cycle WHERE id IN (SELECT c.id FROM checker_cycle c WHERE c.completed_at IS NOT NULL AND c.completed_at < ?1 ` +
    `AND NOT EXISTS (SELECT 1 FROM checker_shard s WHERE s.cycle_id = c.id) AND NOT EXISTS (SELECT 1 FROM checker_result r WHERE r.cycle_id = c.id) LIMIT ${PRUNE_BATCH})`,
};

/// The hourly pruning statement for the tick at `nowS` (one statement, at most PRUNE_BATCH rows).
export function pruneStatement(db: D1Database, nowS: number): { target: PruneTarget; stmt: D1PreparedStatement } {
  const target = pruneTarget(nowS);
  return { target, stmt: db.prepare(PRUNE_SQL[target]).bind(pruneCutoff(target, nowS)) };
}
