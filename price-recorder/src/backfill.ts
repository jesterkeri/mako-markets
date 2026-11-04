// ----------------------------------------------------------------------------
// price-recorder/src/backfill.ts
//
// Backfill and gap repair (CHARTS_DS_PLAN 6, 4.1, 4.2 step 2). The unit of work is one (feed, hour) in `todo`:
//   * the gap scan (hourly, and on the first recording ticks before any old 1h row exists) queues every (feed, hour) of
//     [now - 30 d + 1 h, now - 15 min] whose 1h row is missing or has n_min_retry > 0, for the feeds not in
//     config.feeds_refused; a queued hour keeps its tries, except that the scan at 00:00 UTC resets them (3 a day);
//   * a tick selects up to floor(P_bf / 37) units, newest hour first, then BTC and ETH, then forex, metals and stocks,
//     then the other crypto; P_bf is halved while a 429 was seen in the last 10 minutes; units of feeds in
//     config.feeds_refused or in the newest runs row's `unauthorized` are not selected, nor units with 3 tries;
//   * a unit fetches its hour's 60 minutes through the same fetcher as live and catch-up, at most 40 pages, and its
//     rows go through the same merge (plan.ts); it leaves `todo` only in the batch that writes them, once the merged
//     hour has n_min_retry = 0; a unit that made at least one call and did not finish gets tries + 1; one that made no
//     call (the limiter stopped first, or its feed was refused this tick) is unchanged.
// The 15-minute holdback keeps backfill hours disjoint from the live and catch-up minutes (the last 11), so one tick
// never builds the same minute twice.
// ----------------------------------------------------------------------------

import type { PageResult } from './client';
import { isInt } from './db';
import { validOnce, type FetchContext } from './fetcher';
import { D1_NOW } from './lease';
import { FEEDS, type Feed } from './feeds';
import { align, DAY, HOUR } from './rollup';
import { REPAIR_HORIZON_S } from './retention';

/// Plan 6: 37 pages prove an hour at one report a second; a unit may take up to 40.
export const PAGES_PER_UNIT = 37;
export const BACKFILL_PAGE_CAP = 40;
export const HOLDBACK_S = 15 * 60;
export const MAX_TRIES = 3;
/// Plan 4.1: a 429 halves P_bf for 10 minutes.
export const RATE_LIMIT_COOLDOWN_S = 600;

/// The hours backfill and the gap scan may take at `horizon` (the end of the live minute): the first and the last
/// hour start, both inclusive.
export function repairWindow(horizon: number): { first: number; last: number } {
  const first = align(horizon - REPAIR_HORIZON_S + HOUR + HOUR - 1, HOUR); // the first hour starting at or after now - 30 d + 1 h
  const last = align(horizon - HOLDBACK_S, HOUR) - HOUR; // the last hour that ended by now - 15 min
  return { first, last };
}

/// Selection order within an hour (plan 6): BTC and ETH (rounds), then forex, metals and stocks, then the rest.
export const UNIT_PRIORITY: readonly string[] = [
  ...['BTC', 'ETH'].filter((s) => FEEDS.some((f) => f.symbol === s)),
  ...FEEDS.filter((f) => f.class !== 'crypto').map((f) => f.symbol),
  ...FEEDS.filter((f) => f.class === 'crypto' && f.symbol !== 'BTC' && f.symbol !== 'ETH').map((f) => f.symbol),
];

export type Unit = { feed: string; hour: number; tries: number };
/// `stale`: queued hours that fell out of the repair window (they can no longer be fetched); the tick deletes them
/// with its finished units, at most STALE_BATCH a tick.
export type TickState = { recent429: boolean; needFill: boolean; checker: string | null; units: Unit[]; stale: Unit[] };
export const STALE_BATCH = 100;

/// Plan 4.2 step 2, one statement returning one row per selected unit (or one row with null unit columns): whether a
/// 429 was seen in the last 10 minutes, whether no 1h row ended by the window yet (first start: fill now rather than at
/// the next hour), the open checker cycle and its current shard (checker.ts), the units, and up to STALE_BATCH queued
/// hours older than the window.
/// The open checker cycle and its current shard as one JSON object, or NULL (checker.ts parseOpenCycle).
export const OPEN_CYCLE_SQL =
  `(SELECT json_object('id', c.id, 'total', c.shards_total, 'next', c.next_index, 'stuck', c.stuck, 'feed', s.feed, 'day', s.day) ` +
  `FROM checker_cycle c LEFT JOIN checker_shard s ON s.cycle_id = c.id AND s.ordinal = c.next_index ` +
  `WHERE c.completed_at IS NULL ORDER BY c.id DESC LIMIT 1)`;

/// ?1 feeds_refused JSON, ?2 first hour, ?3 last hour, ?4 limit, ?5 priority JSON.
export const STATE_SQL =
  `WITH st AS (SELECT ` +
  `EXISTS (SELECT 1 FROM runs WHERE n_429 > 0 AND t >= ${D1_NOW} - ${RATE_LIMIT_COOLDOWN_S}) AS recent429, ` +
  `NOT EXISTS (SELECT 1 FROM candles_1h WHERE t <= ?3) AS need_fill, ` +
  `COALESCE((SELECT unauthorized FROM runs ORDER BY t DESC LIMIT 1), '[]') AS unauth, ` +
  `${OPEN_CYCLE_SQL} AS checker), ` +
  `u AS (SELECT todo.feed, todo.hour, todo.tries FROM todo, st WHERE todo.tries < ${MAX_TRIES} AND todo.hour >= ?2 AND todo.hour <= ?3 ` +
  `AND todo.feed NOT IN (SELECT value FROM json_each(?1)) AND todo.feed NOT IN (SELECT value FROM json_each(st.unauth)) ` +
  `ORDER BY todo.hour DESC, COALESCE((SELECT key FROM json_each(?5) WHERE value = todo.feed), 999) LIMIT ?4), ` +
  `s AS (SELECT feed, hour, tries FROM todo WHERE hour < ?2 LIMIT ${STALE_BATCH}), ` +
  `x AS (SELECT 'unit' AS kind, feed, hour, tries FROM u UNION ALL SELECT 'stale', feed, hour, tries FROM s) ` +
  `SELECT st.recent429, st.need_fill, st.checker, x.kind, x.feed, x.hour, x.tries FROM st LEFT JOIN x ON 1`;


export async function readTickState(db: D1Database, feedsRefused: readonly string[], horizon: number, pBf: number): Promise<TickState> {
  const { first, last } = repairWindow(horizon);
  const limit = Math.floor(pBf / PAGES_PER_UNIT);
  const res = await db.prepare(STATE_SQL).bind(JSON.stringify(feedsRefused), first, last, limit, JSON.stringify(UNIT_PRIORITY)).all<Record<string, unknown>>();
  const rows = res.results;
  if (rows.length === 0) throw new Error('state read returned no row');
  const head = rows[0];
  const units: Unit[] = [];
  const stale: Unit[] = [];
  for (const r of rows) {
    if (r.kind === null) continue;
    if ((r.kind !== 'unit' && r.kind !== 'stale') || typeof r.feed !== 'string' || !isInt(r.hour) || !isInt(r.tries)) throw new Error('bad todo row');
    (r.kind === 'unit' ? units : stale).push({ feed: r.feed, hour: r.hour, tries: r.tries });
  }
  return { recent429: head.recent429 === 1, needFill: head.need_fill === 1, checker: typeof head.checker === 'string' ? head.checker : null, units, stale };
}

/// Units this tick may run (plan 4.1): P_bf, halved after a recent 429, less the pages already spent on catch-up, in
/// units of 37.
export const unitBudget = (pBf: number, recent429: boolean, spentPages = 0): number =>
  Math.floor(Math.max(0, (recent429 ? Math.floor(pBf / 2) : pBf) - spentPages) / PAGES_PER_UNIT);

/// The gap scan (plan 6). ?1 the feeds to queue (JSON), ?2 first hour, ?3 last hour, ?4 1 to reset tries (00:00 UTC).
/// A (feed, hour) is queued when its 1h row is missing or still has minutes to retry (missing or incomplete); proven
/// gaps are final. ~24,500 primary-key lookups an hour.
export const GAP_SCAN_SQL =
  `WITH RECURSIVE hrs(h) AS (SELECT ?2 WHERE ?2 <= ?3 UNION ALL SELECT h + ${HOUR} FROM hrs WHERE h + ${HOUR} <= ?3) ` +
  `INSERT INTO todo (feed, hour, tries) SELECT f.value, hrs.h, 0 FROM json_each(?1) f, hrs ` +
  `WHERE NOT EXISTS (SELECT 1 FROM candles_1h c WHERE c.feed = f.value AND c.t = hrs.h AND c.n_min_retry = 0) ` +
  `ON CONFLICT(feed, hour) DO UPDATE SET tries = 0 WHERE ?4 = 1`;

export function gapScan(db: D1Database, feeds: readonly string[], horizon: number): D1PreparedStatement {
  const { first, last } = repairWindow(horizon);
  const midnight = (horizon - 60) % DAY === 0 ? 1 : 0; // the live minute is 00:00 UTC
  return db.prepare(GAP_SCAN_SQL).bind(JSON.stringify(feeds), first, last, midnight);
}

const PAIRS = `SELECT json_extract(value, '$.feed'), json_extract(value, '$.hour') FROM json_each(?1)`;
export const TODO_DONE_SQL = `DELETE FROM todo WHERE (feed, hour) IN (${PAIRS})`;
export const TODO_TRIED_SQL = `UPDATE todo SET tries = tries + 1 WHERE (feed, hour) IN (${PAIRS})`;

/// What became of each unit this tick: finished (its merged hour has nothing left to retry), tried (it made at least
/// one call and did not finish), or untouched. `halted`: the tick stopped every call (a 429 or a whole-key failure,
/// plan 4.1), a service-wide interruption, so no unfinished unit is charged a try; a unit that finished before the
/// halt still leaves `todo` (Codex RECORDER_D R1 F1).
export function unitOutcomes(
  units: readonly Unit[],
  pages: readonly number[],
  hours: readonly { feed: string; t: number; n_min_retry: number }[],
  halted: boolean,
): { done: Unit[]; tried: Unit[] } {
  const retry = new Map(hours.map((h) => [`${h.feed}:${h.t}`, h.n_min_retry]));
  const done: Unit[] = [];
  const tried: Unit[] = [];
  units.forEach((u, i) => {
    if (pages[i] === 0) return;
    if (retry.get(`${u.feed}:${u.hour}`) === 0) done.push(u);
    else if (!halted) tried.push(u);
  });
  return { done, tried };
}

export function todoWrites(db: D1Database, done: readonly Unit[], tried: readonly Unit[]): D1PreparedStatement[] {
  const json = (us: readonly Unit[]) => JSON.stringify(us.map((u) => ({ feed: u.feed, hour: u.hour })));
  const out: D1PreparedStatement[] = [];
  if (done.length > 0) out.push(db.prepare(TODO_DONE_SQL).bind(json(done)));
  if (tried.length > 0) out.push(db.prepare(TODO_TRIED_SQL).bind(json(tried)));
  return out;
}

/// Plan 4.1: one restoration probe per feed in config.feeds_refused, on the hourly gap-scan tick, from now - 120, with
/// limit=1. Returns every answer (they count toward the tick's n_429 and key_failure like any other) and the feeds that
/// answered a valid entry (logged `feed_restored`; the operator then lifts the listing).
export const PROBE_LOOKBACK_S = 120;

export async function probeRefused(ctx: FetchContext, listed: readonly Feed[], nowS: number): Promise<{ answers: PageResult[]; restored: string[] }> {
  const answers: PageResult[] = [];
  const restored: string[] = [];
  await Promise.all(
    listed.map(async (f) => {
      if (ctx.limiter.halted !== null) return;
      const res = await ctx.limiter.run(() => ctx.client(f.feedId, nowS - PROBE_LOOKBACK_S, 1));
      if (!res.ran) return;
      if (res.value.kind === 'unsent') {
        ctx.limiter.notSent();
        return;
      }
      answers.push(res.value);
      if (res.value.kind === 'ok' && res.value.reports.some((e) => e !== null && typeof e === 'object' && !Array.isArray(e) && validOnce(e as Record<string, unknown>, f) !== null)) restored.push(f.symbol);
    }),
  );
  return { answers, restored };
}
