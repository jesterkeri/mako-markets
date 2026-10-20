// CHARTS_DS_PLAN 5.2 and section 11 on a local D1 built from migrations/: the tables and their CHECKs, the seeded
// config (serve = 0, record = 0: the Worker deploys dark), the operator commands of section 11 and 8.6 run verbatim,
// the fence of 4.4 (a CHECK failure rolls back the whole batch), and the query plans of the bounded reads.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { PRUNE_SQL, READ_HOURS_SQL, READ_MINUTES_SQL, UPSERT_MINUTES_SQL } from '../src/db';

const db = () => env.DB;
const all = async (sql: string, ...args: unknown[]) => (await db().prepare(sql).bind(...args).all<Record<string, unknown>>()).results;

// Section 11, verbatim.
const KILL = "INSERT INTO config (id, serve, record, p_bf, updated_at) VALUES (1, 0, 0, 0, CAST(strftime('%s','now') AS INTEGER)) ON CONFLICT(id) DO UPDATE SET serve = 0, updated_at = excluded.updated_at RETURNING id, serve, record";
const SERVE_ON = "UPDATE config SET serve = 1, updated_at = CAST(strftime('%s','now') AS INTEGER) WHERE id = 1 RETURNING serve";
// 8.6, verbatim (AAPL).
const HOLD = "INSERT INTO feed_holds (symbol, since, source) VALUES ('AAPL', CAST(strftime('%s','now') AS INTEGER), 'operator') ON CONFLICT(symbol) DO NOTHING RETURNING symbol";
const GUARDED_DELETE = "DELETE FROM feed_holds WHERE symbol = 'AAPL' AND EXISTS (SELECT 1 FROM latest WHERE feed = 'AAPL' AND obs > feed_holds.since AND obs >= CAST(strftime('%s','now') AS INTEGER) - 600) RETURNING symbol";

describe('migration 0001', () => {
  it('creates exactly the plan 5.2 tables', async () => {
    const names = (await all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' ORDER BY name")).map((r) => r.name);
    expect(names).toEqual(['candles_15m', 'candles_1d', 'candles_1h', 'candles_1m', 'checker_cycle', 'checker_result', 'checker_shard', 'config', 'conflicts', 'feed_holds', 'latest', 'lease', 'lease_guard', 'runs', 'todo']);
  });

  it('has no secondary index: only the ones primary keys and the checker_shard UNIQUE create', async () => {
    const idx = await all("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name NOT LIKE '_cf_%' AND tbl_name <> 'd1_migrations'");
    for (const i of idx) expect(i.sql, String(i.name)).toBeNull();
    expect(idx.map((i) => i.tbl_name).sort()).toEqual(['checker_result', 'checker_shard', 'checker_shard', 'latest']);
  });

  it('seeds config with serve 0, record 0, p_bf 74 and BAC, MA refused (the Worker deploys dark)', async () => {
    const rows = await all('SELECT id, serve, record, p_bf, typeof(updated_at) AS u, feeds_refused, live_unsupported FROM config');
    expect(rows).toEqual([{ id: 1, serve: 0, record: 0, p_bf: 74, u: 'integer', feeds_refused: '["BAC","MA"]', live_unsupported: '[]' }]);
  });

  it('seeds the lease free (until 0, no holder)', async () => {
    expect(await all('SELECT id, until, holder FROM lease')).toEqual([{ id: 1, until: 0, holder: null }]);
    expect(await all('SELECT * FROM lease_guard')).toEqual([]);
  });
});

describe('config CHECKs and the section 11 commands', () => {
  it('the kill switch prints exactly one row with serve 0 on the seeded database', async () => {
    await all(SERVE_ON);
    expect(await all(KILL)).toEqual([{ id: 1, serve: 0, record: 0 }]);
  });

  it('the kill switch prints exactly one row with serve 0 on an empty config table', async () => {
    await all('DELETE FROM config');
    expect(await all(KILL)).toEqual([{ id: 1, serve: 0, record: 0 }]);
  });

  it('turning serving on prints one row with 1', async () => {
    expect(await all(SERVE_ON)).toEqual([{ serve: 1 }]);
  });

  it.each([
    ['serve = 2', "UPDATE config SET serve = 2 WHERE id = 1"],
    ["serve = '1'", "UPDATE config SET serve = '1' WHERE id = 1"],
    ["record = '0'", "UPDATE config SET record = '0' WHERE id = 1"],
    ['record = 1.0', 'UPDATE config SET record = 1.0 WHERE id = 1'],
    ['record = 1.5', 'UPDATE config SET record = 1.5 WHERE id = 1'],
    ['serve = NULL', 'UPDATE config SET serve = NULL WHERE id = 1'],
    ['p_bf = 297', 'UPDATE config SET p_bf = 297 WHERE id = 1'],
    ['a second row', "INSERT INTO config (id, serve, record, p_bf, updated_at) VALUES (2, 0, 0, 74, 0)"],
    ['feeds_refused not JSON', "UPDATE config SET feeds_refused = 'BAC' WHERE id = 1"],
    ['feeds_refused an object', `UPDATE config SET feeds_refused = '{"a":1}' WHERE id = 1`],
    ['live_unsupported not an array', "UPDATE config SET live_unsupported = '1' WHERE id = 1"],
  ])('rejects %s', async (_n, sql) => {
    await expect(all(sql)).rejects.toThrow();
    expect(await all('SELECT serve, record, p_bf FROM config')).toEqual([{ serve: 0, record: 0, p_bf: 74 }]);
  });
});

describe('candle and evidence CHECKs', () => {
  const base = { feed: 'BTC', t: 1792076400, n_reports: 0, n_open: 0, n_rejected: 0, n_valid: 0, n_raw: 0, raw_rule: 1, rules_version: 'x', tries: 0 };
  const ins = (row: Record<string, unknown>) => db().prepare(UPSERT_MINUTES_SQL).bind(JSON.stringify([row])).run();

  it('stores an incomplete row with n_rejected > 0 and n_raw 0 as it is (carry-forward from unit a)', async () => {
    await ins({ ...base, state: 'incomplete', n_rejected: 3 });
    expect(await all('SELECT state, n_rejected, n_raw, raw_fp FROM candles_1m')).toEqual([{ state: 'incomplete', n_rejected: 3, n_raw: 0, raw_fp: null }]);
  });

  it.each([
    ['an unknown state', { ...base, state: 'missing' }],
    ['an open row without OHLC', { ...base, state: 'open' }],
    ['a closed row with OHLC', { ...base, state: 'closed', o: '1', h: '1', l: '1', c: '1' }],
    ['an open row with one price missing', { ...base, state: 'open', o: '1', h: '1', l: '1' }],
    ['a t that is not a minute', { ...base, t: 1792076401, state: 'empty' }],
  ])('rejects %s', async (_n, row) => {
    await expect(ins(row)).rejects.toThrow();
  });

  it('rejects a bucket whose OHLC disagrees with n_min_open, and a misaligned bucket', async () => {
    await expect(all("INSERT INTO candles_1h (feed, t, o, h, l, c, n_min_open, n_min_closed, n_min_gap, n_min_retry) VALUES ('BTC', 1792076400, NULL, NULL, NULL, NULL, 1, 0, 0, 0)")).rejects.toThrow();
    await expect(all("INSERT INTO candles_1h (feed, t, o, h, l, c, n_min_open, n_min_closed, n_min_gap, n_min_retry) VALUES ('BTC', 1792076460, NULL, NULL, NULL, NULL, 0, 0, 60, 60)")).rejects.toThrow();
    await expect(all("INSERT INTO candles_15m (feed, t, o, h, l, c, n_min_open, n_min_closed, n_min_gap, n_min_retry) VALUES ('BTC', 1792076460, NULL, NULL, NULL, NULL, 0, 0, 15, 15)")).rejects.toThrow();
    await expect(all("INSERT INTO candles_1d (feed, t, o, h, l, c, n_min_open, n_min_closed, n_min_gap, n_min_retry) VALUES ('BTC', 1792076400, NULL, NULL, NULL, NULL, 0, 0, 0, 1440)")).rejects.toThrow();
  });

  it('rejects conflict evidence without the fields its kind needs', async () => {
    await expect(all("INSERT INTO conflicts (feed, kind, minute, seen_at) VALUES ('BTC', 'same_second', 1792076400, 0)")).rejects.toThrow();
    await expect(all("INSERT INTO conflicts (feed, kind, minute, seen_at) VALUES ('BTC', 'refetch_mismatch', 1792076400, 0)")).rejects.toThrow();
    await expect(all("INSERT INTO conflicts (feed, kind, minute, seen_at) VALUES ('BTC', 'other', 1792076400, 0)")).rejects.toThrow();
  });

  it('rejects a runs row whose unauthorized list is not a JSON array, and key_failure 2', async () => {
    await expect(all("INSERT INTO runs (t, unauthorized) VALUES (1, 'BAC')")).rejects.toThrow();
    await expect(all('INSERT INTO runs (t, key_failure) VALUES (1, 2)')).rejects.toThrow();
    await all(`INSERT INTO runs (t, calls, unauthorized) VALUES (1, 34, '["BAC"]')`);
  });
});

describe('feed_holds (8.6): add-only from code, guarded delete by the operator', () => {
  it('the operator hold prints one row, then none on a repeat (ON CONFLICT DO NOTHING)', async () => {
    expect(await all(HOLD)).toEqual([{ symbol: 'AAPL' }]);
    expect(await all(HOLD)).toEqual([]);
    await expect(all("INSERT INTO feed_holds (symbol, since, source) VALUES ('MSFT', 0, 'code')")).rejects.toThrow();
  });

  it('the guarded delete prints 0 rows without a report newer than the hold and from the last 10 minutes, then 1', async () => {
    const now = (await all("SELECT CAST(strftime('%s','now') AS INTEGER) AS n"))[0].n as number;
    await all("INSERT INTO feed_holds (symbol, since, source) VALUES ('AAPL', ?1, 'tick')", now - 100);
    // A report from before the hold: still recent, but not newer than `since`.
    await all("INSERT INTO latest (feed, price, obs, last_update_ns, market_status) VALUES ('AAPL', '1', ?1, '1', 2)", now - 200);
    expect(await all(GUARDED_DELETE)).toEqual([]);
    // A report newer than the hold but older than 10 minutes is impossible here (since is 100 s ago); a newer one lifts it.
    await all('UPDATE latest SET obs = ?1 WHERE feed = ?2', now - 50, 'AAPL');
    expect(await all(GUARDED_DELETE)).toEqual([{ symbol: 'AAPL' }]);
    expect(await all('SELECT * FROM feed_holds')).toEqual([]);
  });

  it('a report newer than the hold but more than 10 minutes old does not lift it', async () => {
    const now = (await all("SELECT CAST(strftime('%s','now') AS INTEGER) AS n"))[0].n as number;
    await all("INSERT INTO feed_holds (symbol, since, source) VALUES ('AAPL', ?1, 'tick')", now - 2000);
    await all("INSERT INTO latest (feed, price, obs, last_update_ns, market_status) VALUES ('AAPL', '1', ?1, '1', 2)", now - 700);
    expect(await all(GUARDED_DELETE)).toEqual([]);
  });
});

describe('the lease fence (4.4): a CHECK failure aborts the whole batch', () => {
  it('a batch whose guard insert fails writes nothing, its earlier and later statements included', async () => {
    const d = db();
    await expect(
      d.batch([
        d.prepare("INSERT INTO runs (t, calls) VALUES (1, 1)"),
        d.prepare("INSERT INTO lease_guard (ok) SELECT COALESCE((SELECT holder = 'me' AND until >= 0 FROM lease WHERE id = 1), 0)"),
        d.prepare("INSERT INTO runs (t, calls) VALUES (2, 1)"),
      ]),
    ).rejects.toThrow();
    expect(await all('SELECT * FROM runs')).toEqual([]);
    expect(await all('SELECT * FROM lease_guard')).toEqual([]);
  });
});

describe('query plans: reads and pruning go through the primary keys (plan 4.2 step 4, 5.3)', () => {
  const plan = async (sql: string, ...args: unknown[]) => (await all(`EXPLAIN QUERY PLAN ${sql}`, ...args)).map((r) => String(r.detail)).join('\n');

  it('the touched-hours read searches candles_1m by (feed, t) range per element', async () => {
    expect(await plan(READ_MINUTES_SQL, '[]')).toMatch(/SEARCH m USING PRIMARY KEY \(feed=\? AND t>\? AND t<\?\)/);
  });

  it('the touched-days read searches candles_1h by (feed, t) range per element', async () => {
    expect(await plan(READ_HOURS_SQL, '[]')).toMatch(/SEARCH b USING PRIMARY KEY \(feed=\? AND t>\? AND t<\?\)/);
  });

  it('candle pruning searches by (feed, t < cutoff) per feed, never a full scan of the candle table', async () => {
    for (const t of ['candles_1m', 'candles_15m'] as const) {
      const p = await plan(PRUNE_SQL[t], 0);
      expect(p, t).toMatch(/SEARCH m USING PRIMARY KEY \(feed=\? AND t<\?\)/);
      expect(p, t).not.toMatch(new RegExp(`SCAN ${t}\\b`));
      expect(p, t).not.toMatch(/SCAN m\b/);
    }
  });

  it('runs pruning searches by rowid range', async () => {
    expect(await plan(PRUNE_SQL.runs, 0)).toMatch(/SEARCH runs USING INTEGER PRIMARY KEY \(rowid<\?\)/);
  });
});
