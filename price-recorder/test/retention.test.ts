// CHARTS_DS_PLAN 5.3 retention on a local D1: 1m 35 days, 15m 120 days, 1h and 1d kept, runs 7 days, checker rows
// with their cycle 7 days after it completed; one statement per hourly tick, at most 5,000 rows; nothing else touched.
// Plus the sweep C invariant (no recompute ever needs a pruned minute) and the steady-state capacity of the rotation.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { pruneStatement, PRUNE_SQL } from '../src/db';
import { KEEP_15M_S, KEEP_1M_S, KEEP_CHECKER_S, KEEP_LIVE_STATS_S, KEEP_RUNS_S, ODD_ROTATION, PRUNE_BATCH, pruneCutoff, pruneTarget, REPAIR_HORIZON_S, type PruneTarget } from '../src/retention';
import { align, DAY, HOUR } from '../src/rollup';

const db = () => env.DB;
const rows = async (sql: string) => (await db().prepare(sql).all<Record<string, unknown>>()).results;
const count = async (table: string, where = 'true') => (await rows(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`))[0].n as number;
const NOW_EVEN = 1792195200; // 2026-10-17 00:00 UTC, an even hour since the epoch
const NOW_ODD = NOW_EVEN + HOUR;

const minute = (feed: string, t: number) => ({ feed, t, state: 'closed', n_reports: 1, n_open: 0, n_rejected: 0, n_valid: 1, n_raw: 1, raw_rule: 1, rules_version: 'r', tries: 0 });
const bucket = (feed: string, t: number) => ({ feed, t, n_min_open: 0, n_min_closed: 15, n_min_gap: 0, n_min_retry: 0 });
async function insert(table: string, objs: Record<string, unknown>[]) {
  const cols = Object.keys(objs[0]);
  for (let i = 0; i < objs.length; i += 2000) {
    const chunk = JSON.stringify(objs.slice(i, i + 2000));
    await db().prepare(`INSERT INTO ${table} (${cols.join(', ')}) SELECT ${cols.map((c) => `json_extract(value, '$.${c}')`).join(', ')} FROM json_each(?1)`).bind(chunk).run();
  }
}
const day1d = (feed: string, t: number) => ({ feed, t: align(t, DAY), n_min_open: 0, n_min_closed: 1440, n_min_gap: 0, n_min_retry: 0 });

describe('schedule (pure)', () => {
  it('even hours prune candles_1m, odd hours rotate through the rest, each every 12 hours', () => {
    expect(pruneTarget(NOW_EVEN)).toBe('candles_1m');
    expect(pruneTarget(NOW_EVEN + 3599)).toBe('candles_1m');
    const odd = Array.from({ length: 12 }, (_, i) => pruneTarget(NOW_ODD + 2 * HOUR * i));
    expect(new Set(odd)).toEqual(new Set(ODD_ROTATION));
    for (let i = 0; i < 6; i++) expect(odd[i]).toBe(odd[i + 6]);
    // checker_cycle never comes before its shards and results within one rotation.
    expect(ODD_ROTATION.indexOf('checker_cycle')).toBeGreaterThan(ODD_ROTATION.indexOf('checker_shard'));
    expect(ODD_ROTATION.indexOf('checker_cycle')).toBeGreaterThan(ODD_ROTATION.indexOf('checker_result'));
  });

  it('cutoffs: 35 days, 120 days, 7 days, live_stats 30 days', () => {
    expect(pruneCutoff('live_stats', NOW_EVEN)).toBe(NOW_EVEN - 30 * DAY);
    expect(pruneCutoff('candles_1m', NOW_EVEN)).toBe(NOW_EVEN - 35 * DAY);
    expect(pruneCutoff('candles_15m', NOW_EVEN)).toBe(NOW_EVEN - 120 * DAY);
    expect(pruneCutoff('runs', NOW_EVEN)).toBe(NOW_EVEN - 7 * DAY);
    for (const t of ['checker_result', 'checker_shard', 'checker_cycle'] as const) expect(pruneCutoff(t, NOW_EVEN)).toBe(NOW_EVEN - 7 * DAY);
  });

  it('sweep C: the oldest minute any writer can recompute is newer than the 1m cutoff, at any time', () => {
    for (const now of [NOW_EVEN, NOW_EVEN + 1, NOW_EVEN + 1799, NOW_ODD + 59]) {
      // plan 6: backfill hours lie in [now - 30 d + 1 h, now - 15 min]; the bucket of the oldest one starts at or after it.
      const oldestHour = align(now - REPAIR_HORIZON_S + HOUR, HOUR);
      expect(oldestHour).toBeGreaterThanOrEqual(pruneCutoff('candles_1m', now));
      // ...and its day's 1d row is rebuilt from 1h rows, which are never pruned.
    }
    expect(KEEP_1M_S - REPAIR_HORIZON_S).toBeGreaterThanOrEqual(DAY);
  });

  it('steady state: what a table gains between two of its turns stays under one batch of 5,000', () => {
    const perHour: Record<PruneTarget, number> = {
      candles_1m: 34 * 60, // one row per feed per minute
      candles_15m: 34 * 4,
      runs: 60, // one per tick
      live_stats: 34, // one per feed per hour (plan 8.3)
      checker_result: 60, // one shard per tick
      checker_shard: Math.ceil((1054 * 24) / 17.6 / 24), // 1,054 per cycle, a cycle every ~17.6 h
      checker_cycle: 1,
    };
    const interval = (t: PruneTarget) => (t === 'candles_1m' ? 2 : 2 * ODD_ROTATION.length);
    for (const t of Object.keys(perHour) as PruneTarget[]) expect(perHour[t] * interval(t), t).toBeLessThan(PRUNE_BATCH);
    // A whole cycle's shards fit one batch, so a completed cycle's shards go in one turn.
    expect(1054).toBeLessThan(PRUNE_BATCH);
    expect([KEEP_1M_S, KEEP_15M_S, KEEP_RUNS_S, KEEP_CHECKER_S, KEEP_LIVE_STATS_S]).toEqual([35 * DAY, 120 * DAY, 7 * DAY, 7 * DAY, 30 * DAY]);
  });
});

describe('pruning on local D1', () => {
  it('candles_1m: rows strictly older than 35 days go, the cutoff minute and newer stay, other tables untouched', async () => {
    const cut = NOW_EVEN - KEEP_1M_S;
    const ts = [cut - 120, cut - 60, cut, cut + 60];
    await insert('candles_1m', ['BTC', 'AAPL'].flatMap((f) => ts.map((t) => minute(f, t))));
    await insert('candles_15m', [bucket('BTC', align(cut - 120, 900))]);
    await insert('candles_1h', [{ ...bucket('BTC', align(cut - 120, HOUR)), n_min_closed: 60 }]);
    await insert('candles_1d', ['BTC', 'AAPL'].map((f) => day1d(f, cut - 120)));
    await db().prepare("INSERT INTO conflicts (feed, kind, minute, obs, keccak_a, keccak_b, rules_version_new, seen_at) VALUES ('BTC', 'same_second', 0, 0, 'a', 'b', 'r', 0)").run();
    await db().prepare("INSERT INTO feed_holds (symbol, since, source) VALUES ('BAC', 0, 'operator')").run();
    await db().prepare('INSERT INTO todo (feed, hour, tries) VALUES (?1, 0, 0)').bind('BTC').run();
    const { target, stmt } = pruneStatement(db(), NOW_EVEN);
    expect(target).toBe('candles_1m');
    const res = await stmt.run();
    expect(res.meta.changes).toBe(4);
    expect((await rows('SELECT feed, t FROM candles_1m ORDER BY feed, t')).map((r) => [r.feed, (r.t as number) - cut])).toEqual([['AAPL', 0], ['AAPL', 60], ['BTC', 0], ['BTC', 60]]);
    expect([await count('candles_15m'), await count('candles_1h'), await count('candles_1d'), await count('conflicts'), await count('feed_holds'), await count('todo'), await count('config'), await count('lease')]).toEqual([1, 1, 2, 1, 1, 1, 1, 1]);
  });

  it('deletes at most 5,000 rows a statement; the next turn takes the rest', async () => {
    const cut = NOW_EVEN - KEEP_1M_S;
    await insert('candles_1m', Array.from({ length: 5003 }, (_, i) => minute(i % 2 ? 'BTC' : 'ETH', cut - 60 * (1 + Math.floor(i / 2)))));
    await insert('candles_1d', ['BTC', 'ETH'].map((f) => day1d(f, cut)));
    expect((await pruneStatement(db(), NOW_EVEN).stmt.run()).meta.changes).toBe(5000);
    expect(await count('candles_1m')).toBe(3);
    expect((await pruneStatement(db(), NOW_EVEN + 2 * HOUR).stmt.run()).meta.changes).toBe(3);
  });

  it('candles_15m at 120 days on its odd-hour turn', async () => {
    const now = [...Array(10).keys()].map((i) => NOW_ODD + 2 * HOUR * i).find((t) => pruneTarget(t) === 'candles_15m')!;
    const cut = now - KEEP_15M_S;
    await insert('candles_15m', [bucket('BTC', align(cut, 900) - 900), bucket('BTC', align(cut, 900) + 900)]);
    await insert('candles_1d', [day1d('BTC', cut)]);
    const { target, stmt } = pruneStatement(db(), now);
    expect(target).toBe('candles_15m');
    expect((await stmt.run()).meta.changes).toBe(1);
    expect(await count('candles_15m')).toBe(1);
  });

  it('live_stats at 30 days', async () => {
    const now = [...Array(12).keys()].map((i) => NOW_ODD + 2 * HOUR * i).find((t) => pruneTarget(t) === 'live_stats')!;
    const cut = now - KEEP_LIVE_STATS_S;
    const zero = 'expected, exact, missing, other_second, invalid, regress, conflict, publisher_gap, unresolved, boundary, backoff, failed, refused, max_gap_s';
    for (const hour of [align(cut, HOUR) - HOUR, align(cut, HOUR) + HOUR])
      await db().prepare(`INSERT INTO live_stats (feed, hour, ${zero}) VALUES ('BTC', ?1, 0,0,0,0,0,0,0,0,0,0,0,0,0,0)`).bind(hour).run();
    expect((await pruneStatement(db(), now).stmt.run()).meta.changes).toBe(1);
    expect((await rows('SELECT hour FROM live_stats')).map((r) => r.hour)).toEqual([align(cut, HOUR) + HOUR]);
  });

  it('runs at 7 days', async () => {
    const now = [...Array(10).keys()].map((i) => NOW_ODD + 2 * HOUR * i).find((t) => pruneTarget(t) === 'runs')!;
    const cut = now - KEEP_RUNS_S;
    for (const t of [cut - 60, cut - 1, cut, cut + 60]) await db().prepare('INSERT INTO runs (t) VALUES (?1)').bind(t).run();
    expect((await pruneStatement(db(), now).stmt.run()).meta.changes).toBe(2);
    expect((await rows('SELECT t FROM runs ORDER BY t')).map((r) => (r.t as number) - cut)).toEqual([0, 60]);
  });

  it('checker rows go with a cycle completed more than 7 days ago; a recent or unfinished cycle stays whole', async () => {
    const cut = NOW_EVEN - KEEP_CHECKER_S;
    const cycles = [
      { id: 1, completed_at: cut - 10 }, // old, done
      { id: 2, completed_at: cut + 10 }, // recent
      { id: 3, completed_at: null }, // running for weeks: never pruned
    ];
    for (const c of cycles) {
      await db().prepare("INSERT INTO checker_cycle (id, started_at, anchor_day, feed_list_json, feed_list_hash, checker_version, shards_total, completed_at) VALUES (?1, 0, 0, '[]', 'h', 'v', 2, ?2)").bind(c.id, c.completed_at).run();
      for (const o of [0, 1]) {
        await db().prepare('INSERT INTO checker_shard (cycle_id, ordinal, feed, day) VALUES (?1, ?2, ?3, 0)').bind(c.id, o, `F${o}`).run();
        await db().prepare("INSERT INTO checker_result (cycle_id, ordinal, feed, day, status, n_buckets, n_diff) VALUES (?1, ?2, ?3, 0, 'ok', 1, 0)").bind(c.id, o, `F${o}`).run();
      }
    }
    // The cycle row cannot go while its shards or results remain.
    expect((await db().prepare(PRUNE_SQL.checker_cycle).bind(cut).run()).meta.changes).toBe(0);
    expect((await db().prepare(PRUNE_SQL.checker_result).bind(cut).run()).meta.changes).toBe(2);
    expect((await db().prepare(PRUNE_SQL.checker_cycle).bind(cut).run()).meta.changes).toBe(0);
    expect((await db().prepare(PRUNE_SQL.checker_shard).bind(cut).run()).meta.changes).toBe(2);
    expect((await db().prepare(PRUNE_SQL.checker_cycle).bind(cut).run()).meta.changes).toBe(1);
    expect((await rows('SELECT id FROM checker_cycle ORDER BY id')).map((r) => r.id)).toEqual([2, 3]);
    expect(await count('checker_shard')).toBe(4);
    expect(await count('checker_result')).toBe(4);
  });

  it('every prune statement is one statement that runs on an empty database', async () => {
    for (const t of Object.keys(PRUNE_SQL) as PruneTarget[]) expect((await db().prepare(PRUNE_SQL[t]).bind(NOW_EVEN).run()).meta.changes, t).toBe(0);
  });
});
