// The read API (CHARTS_DS_PLAN 7.2, 8.2, 8.6, 10, 11, 12; unit e) on local D1: the order of checks (config before the
// token, the token in constant time, then inputs), the kill switch on both serving paths while availability and health
// still answer, candles with gaps and closed time, at most 300 slots, 2h/4h from 1h rows, latest, the availability rule
// at its edges, health, and that the read path writes nothing.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { buildMinute } from '../src/candle';
import { candleWrites, readHoursOfDays, readMinutesOfHours, upsertBuckets, upsertMinutes } from '../src/db';
import { FEEDS } from '../src/feeds';
import { toStored } from '../src/merge';
import { planTick, touchedDays, touchedHours } from '../src/plan';
import { classifyAvailability, handleRead, MAX_CANDLES } from '../src/read';
import { HOUR } from '../src/rollup';
import { derivedSeconds, feed } from './helpers';
import { d1Now, rows } from './tick-helpers';

const TOKEN = 'test-read-token-not-a-credential';
const db = () => env.DB;
const H = 1792173600; // 2026-10-16 18:00:00 UTC

const serve = (n: 0 | 1) => db().prepare(`UPDATE config SET serve = ${n} WHERE id = 1`).run();
function get(path: string, opts: { token?: string | null; method?: string; secret?: string | undefined; database?: D1Database } = {}) {
  const headers = new Headers();
  const token = opts.token === undefined ? TOKEN : opts.token;
  if (token !== null) headers.set('authorization', `Bearer ${token}`);
  const e = { DB: 'database' in opts ? opts.database : db(), RECORDER_READ_TOKEN: 'secret' in opts ? opts.secret : TOKEN };
  return handleRead(new Request(`https://recorder.test${path}`, { method: opts.method ?? 'GET', headers }), e);
}
const body = async (r: Response) => (await r.json()) as Record<string, unknown>;

/// BTC minute t built from derived reports (one a second, plus the witness), proven open.
const openMinute = (t: number) => buildMinute(feed('BTC'), t, derivedSeconds(feed('BTC'), t, t + 61), true);
/// Stores minutes through the production write path (planTick + candleWrites) at `horizon`.
async function store(built: ReturnType<typeof openMinute>[], horizon: number) {
  const [m, h] = await Promise.all([readMinutesOfHours(db(), touchedHours(built)), readHoursOfDays(db(), touchedDays(built))]);
  await db().batch(candleWrites(db(), planTick(built, m, h, horizon)));
}

describe('order of checks (7.2, 11)', () => {
  it('serve = 0: candles and latest answer 503 charts_disabled with or without a token; availability and health answer', async () => {
    for (const path of ['/v1/candles?s=BTC&tf=1m', '/v1/latest?s=BTC']) {
      for (const token of [TOKEN, null]) {
        const r = await get(path, { token });
        expect(r.status, `${path} ${token}`).toBe(503);
        expect(await body(r)).toEqual({ error: 'charts_disabled' });
      }
    }
    expect((await get('/v1/availability')).status).toBe(200);
    expect((await get('/v1/health')).status).toBe(200);
  });

  it('an invalid config answers 503 before the token: charts_disabled on the serving paths, config_invalid on the others', async () => {
    await db().prepare('DELETE FROM config').run();
    for (const [path, error] of [['/v1/candles?s=BTC&tf=1m', 'charts_disabled'], ['/v1/latest?s=BTC', 'charts_disabled'], ['/v1/availability', 'config_invalid'], ['/v1/health', 'config_invalid']] as const) {
      const r = await get(path, { token: null });
      expect(r.status, path).toBe(503);
      expect(await body(r)).toEqual({ error });
    }
    expect((await get('/v1/availability', { database: undefined })).status).toBe(503); // no binding
  });

  it('the token: missing, wrong (same length and other lengths) answer 401; correct answers 200; no secret answers 503', async () => {
    await serve(1);
    const wrongSame = TOKEN.slice(0, -1) + (TOKEN.endsWith('x') ? 'y' : 'x');
    for (const token of [null, wrongSame, 'short', TOKEN + 'longer', '']) {
      const r = await get('/v1/candles?s=BTC&tf=1m', { token });
      expect(r.status, String(token)).toBe(401);
      expect(await body(r)).toEqual({ error: 'unauthorized' });
    }
    expect((await get('/v1/candles?s=BTC&tf=1m')).status).toBe(200);
    for (const secret of [undefined, '', '   ']) expect((await get('/v1/availability', { secret })).status).toBe(503);
  });

  it('inputs after the token: unknown symbol or timeframe 400, a query on availability 400; other methods 405, other paths 404', async () => {
    await serve(1);
    expect((await get('/v1/candles?s=NOPE&tf=1m')).status).toBe(400);
    expect((await get('/v1/candles?s=BTC&tf=3m')).status).toBe(400);
    expect((await get('/v1/latest?s=btc')).status).toBe(400);
    expect((await get('/v1/availability?x=1')).status).toBe(400);
    expect((await get('/v1/candles?s=BTC&tf=1m', { method: 'POST' })).status).toBe(405);
    expect((await get('/v1/other')).status).toBe(404);
    expect((await get('/v1/candles?s=NOPE&tf=1m', { token: null })).status).toBe(401); // the token comes before inputs
    // A refused feed's answer comes after input validation too (Codex RECORDER_E R1).
    expect((await get('/v1/candles?s=BAC&tf=bad')).status).toBe(400);
    expect((await get('/v1/candles?s=BAC')).status).toBe(400);
    expect((await get('/v1/candles?s=BAC&tf=1h')).status).toBe(200);
  });

  it('no answer carries a CORS header; every answer is no-store JSON', async () => {
    await serve(1);
    for (const path of ['/v1/candles?s=BTC&tf=1m', '/v1/latest?s=BTC', '/v1/availability', '/v1/health', '/v1/other']) {
      const r = await get(path);
      expect([...r.headers.keys()].filter((k) => k.startsWith('access-control-')), path).toEqual([]);
      expect(r.headers.get('cache-control')).toBe('no-store');
      expect(r.headers.get('content-type')).toBe('application/json');
    }
  });

  it('a symbol in feeds_refused: 200 unavailable feed_refused, and no candle or latest table is read', async () => {
    await serve(1); // the seeded feeds_refused is ["BAC","MA"]
    const seen: string[] = [];
    const watching = new Proxy(db(), {
      get: (t, k) => {
        if (k === 'prepare') return (sql: string) => (seen.push(sql), t.prepare(sql));
        const v = (t as unknown as Record<PropertyKey, unknown>)[k];
        return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(t) : v;
      },
    });
    const c = await get('/v1/candles?s=BAC&tf=1h', { database: watching });
    expect(await body(c)).toEqual({ candles: [], gaps: [], unavailable: 'feed_refused' });
    const l = await get('/v1/latest?s=MA', { database: watching });
    expect(await body(l)).toEqual({ unavailable: 'feed_refused' });
    expect(seen.filter((s) => /candles_|FROM latest/.test(s))).toEqual([]);
  });
});

describe('candles (7.2, 10)', () => {
  it('1m: open minutes are candles, missing and incomplete minutes are gaps, closed minutes collapse; asOf and marketOpen', async () => {
    await serve(1);
    const t0 = H;
    // open, missing, incomplete, closed, open
    await store([openMinute(t0), buildMinute(feed('BTC'), t0 + 120, [], false), openMinute(t0 + 240)], t0 + 300);
    const closed = { ...toStored(openMinute(t0 + 180), 0), state: 'closed' as const, o: null, h: null, l: null, c: null };
    await db().batch([upsertMinutes(db(), [closed])!]);
    const r = await body(await get('/v1/candles?s=BTC&tf=1m'));
    expect((r.candles as { t: number }[]).map((c) => c.t)).toEqual([t0, t0 + 240]);
    expect(r.gaps).toEqual([t0 + 60, t0 + 120]);
    expect(r.asOf).toBe(t0 + 300);
    expect(r.marketOpen).toBeNull(); // crypto
    const stored = (await rows('SELECT o, h, l, c FROM candles_1m WHERE feed = ?1 AND t = ?2', 'BTC', t0))[0];
    expect((r.candles as Record<string, unknown>[])[0]).toEqual({ t: t0, ...stored });
  });

  it('no gaps before the first stored row; nothing stored is an empty answer with asOf null', async () => {
    await serve(1);
    expect(await body(await get('/v1/candles?s=BTC&tf=1h'))).toEqual({ candles: [], gaps: [], asOf: null, marketOpen: null });
    await store([openMinute(H)], H + 60);
    const r = await body(await get('/v1/candles?s=BTC&tf=1m'));
    expect(r.gaps).toEqual([]);
    expect(r.candles).toHaveLength(1);
  });

  it('at most 300 slots, the newest ones', async () => {
    await serve(1);
    const minutes = Array.from({ length: 320 }, (_, i) => H + i * 60);
    for (let i = 0; i < minutes.length; i += 60) await store(minutes.slice(i, i + 60).map(openMinute), H + 320 * 60);
    const r = await body(await get('/v1/candles?s=BTC&tf=1m'));
    const ts = (r.candles as { t: number }[]).map((c) => c.t);
    expect(ts.length + (r.gaps as number[]).length).toBeLessThanOrEqual(MAX_CANDLES);
    expect(ts).toHaveLength(MAX_CANDLES);
    expect(ts[0]).toBe(minutes[20]);
    expect(ts.at(-1)).toBe(minutes[319]);
  }, 60_000);

  it('1h: a complete hour is a candle; an ended hour with a missing minute is a gap; 2h and 4h are built from 1h rows', async () => {
    await serve(1);
    const full = Array.from({ length: 60 }, (_, i) => openMinute(H + i * 60));
    const holed = Array.from({ length: 60 }, (_, i) => openMinute(H + HOUR + i * 60)).filter((_, i) => i !== 30);
    await store(full, H + 2 * HOUR + 60);
    await store(holed, H + 2 * HOUR + 60);
    await store([openMinute(H + 2 * HOUR)], H + 2 * HOUR + 60); // the newest minute: a forming third hour
    const h1 = await body(await get('/v1/candles?s=BTC&tf=1h'));
    expect((h1.candles as { t: number }[]).map((c) => c.t)).toEqual([H, H + 2 * HOUR]);
    expect(h1.gaps).toEqual([H + HOUR]);
    const h2 = await body(await get('/v1/candles?s=BTC&tf=2h'));
    expect(h2.gaps).toEqual([H]); // [H, H+2h) holds the holed hour
    expect((h2.candles as { t: number }[]).map((c) => c.t)).toEqual([H + 2 * HOUR]);
  }, 60_000);

  it('a closed hour (only closed minutes, nothing missing) leaves no slot, neither candle nor gap (closed time collapses)', async () => {
    await serve(1);
    const eur = feed('EURUSD');
    const closedMin = (t: number) => ({ ...toStored(buildMinute(eur, t, [], true), 0), state: 'closed' as const, o: null, h: null, l: null, c: null });
    await db().batch([
      upsertMinutes(db(), Array.from({ length: 60 }, (_, i) => closedMin(H + i * 60)).concat([closedMin(H + HOUR)]))!,
      upsertBuckets(db(), 'candles_1h', [
        { feed: 'EURUSD', t: H, o: null, h: null, l: null, c: null, n_min_open: 0, n_min_closed: 60, n_min_gap: 0, n_min_retry: 0 },
        { feed: 'EURUSD', t: H + HOUR, o: null, h: null, l: null, c: null, n_min_open: 0, n_min_closed: 1, n_min_gap: 0, n_min_retry: 59 },
      ])!,
    ]);
    expect(await body(await get('/v1/candles?s=EURUSD&tf=1h'))).toMatchObject({ candles: [], gaps: [] });
  });

  it('closed time takes none of the 300 slots: a feed closed for 400 minutes still answers its last 300 open minutes', async () => {
    await serve(1);
    // BTC stands in for a market feed here: the read path classifies by stored state, not by asset class.
    const opens = Array.from({ length: 320 }, (_, i) => H + i * 60);
    for (let i = 0; i < opens.length; i += 60) await store(opens.slice(i, i + 60).map(openMinute), H + 320 * 60);
    const closedRows = Array.from({ length: 400 }, (_, i) => ({ ...toStored(openMinute(H + (320 + i) * 60), 0), state: 'closed' as const, o: null, h: null, l: null, c: null }));
    for (let i = 0; i < closedRows.length; i += 100) await db().batch([upsertMinutes(db(), closedRows.slice(i, i + 100))!]);
    const r = await body(await get('/v1/candles?s=BTC&tf=1m'));
    const ts = (r.candles as { t: number }[]).map((c) => c.t);
    expect(ts).toHaveLength(MAX_CANDLES);
    expect(ts.at(-1)).toBe(opens[319]);
    expect(r.gaps).toEqual([]);
    expect(r.asOf).toBe(H + 720 * 60);
  }, 60_000);

  it('widening the window never reads the same range twice', async () => {
    await serve(1);
    const opens = Array.from({ length: 60 }, (_, i) => H + i * 60);
    await store(opens.map(openMinute), H + 60 * 60);
    const closedRows = Array.from({ length: 1000 }, (_, i) => ({ ...toStored(openMinute(H + (60 + i) * 60), 0), state: 'closed' as const, o: null, h: null, l: null, c: null }));
    for (let i = 0; i < closedRows.length; i += 100) await db().batch([upsertMinutes(db(), closedRows.slice(i, i + 100))!]);
    const ranges: [number, number][] = [];
    const watching = new Proxy(db(), {
      get: (t, k) => {
        if (k === 'prepare')
          return (sql: string) => {
            const stmt = t.prepare(sql);
            if (!sql.startsWith('SELECT * FROM candles_1m WHERE feed = ?1 AND t >= ?2 AND t <= ?3')) return stmt;
            return new Proxy(stmt, { get: (st, kk) => (kk === 'bind' ? (...a: unknown[]) => (ranges.push([a[1] as number, a[2] as number]), st.bind(...a)) : (st as unknown as Record<PropertyKey, unknown>)[kk] instanceof Function ? ((st as unknown as Record<PropertyKey, (...x: unknown[]) => unknown>)[kk]).bind(st) : (st as unknown as Record<PropertyKey, unknown>)[kk]) });
          };
        const v = (t as unknown as Record<PropertyKey, unknown>)[k];
        return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(t) : v;
      },
    });
    const r = await body(await get('/v1/candles?s=BTC&tf=1m', { database: watching }));
    expect((r.candles as unknown[]).length).toBe(60); // only 60 open minutes exist; the window reached the first row
    expect(ranges.length).toBeGreaterThan(1);
    const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i][0]).toBeGreaterThan(sorted[i - 1][1]);
  }, 60_000);

  it("today's 1d candle is not drawn over an hour that ended with minutes never stored", async () => {
    await serve(1);
    const day = H - (H % 86400);
    // Hour `day`: minutes :00 to :30 stored while the hour was forming, never touched again.
    await store(Array.from({ length: 31 }, (_, i) => openMinute(day + i * 60)), day + 31 * 60);
    // The next hour is complete, written after; the newest minute opens the third hour. Every hour of the day so far
    // has a row, so only the stale first hour can make the day a gap.
    await store(Array.from({ length: 60 }, (_, i) => openMinute(day + HOUR + i * 60)), day + 2 * HOUR + 60);
    await store([openMinute(day + 2 * HOUR)], day + 2 * HOUR + 60);
    const d = await body(await get('/v1/candles?s=BTC&tf=1d'));
    expect(d.candles).toEqual([]);
    expect(d.gaps).toEqual([day]);
  }, 60_000);

  it('marketOpen for a forex feed follows the newest minute: closed -> false', async () => {
    await serve(1);
    const eur = feed('EURUSD');
    const row = { ...toStored(buildMinute(eur, H, [], true), 0), state: 'closed' as const, o: null, h: null, l: null, c: null };
    await db().batch([upsertMinutes(db(), [row])!]);
    expect((await body(await get('/v1/candles?s=EURUSD&tf=1m'))).marketOpen).toBe(false);
  });
});

describe('latest (8.2)', () => {
  it('the stored row with absolute timestamps; no row is 404 no_latest', async () => {
    await serve(1);
    expect(await body(await get('/v1/latest?s=EURUSD'))).toEqual({ error: 'no_latest' });
    await db().prepare("INSERT INTO latest (feed, price, obs, last_update_ns, market_status) VALUES ('EURUSD', '1146330000000000000', 1792177799, '1792177798123456789', 2)").run();
    expect(await body(await get('/v1/latest?s=EURUSD'))).toEqual({ price: '1146330000000000000', obs: 1792177799, lastUpdateNs: '1792177798123456789', marketStatus: 2 });
  });
});

describe('availability (8.6)', () => {
  const NOW = 1792177800;
  const base = { now: NOW, holds: [], feedsRefused: [], lastCalling: NOW - 60, newestKeyFailure: 0 };
  const fresh = new Map(FEEDS.map((f) => [f.symbol, NOW - 30]));

  it('every symbol of the two feed tables, each ok when everything is fresh', () => {
    const a = classifyAvailability({ ...base, latestObs: fresh });
    expect(Object.keys(a).sort()).toEqual(FEEDS.map((f) => f.symbol).sort());
    expect(Object.values(a).every((x) => x.state === 'ok')).toBe(true);
  });

  it('the edges: latest at now - 600 ok, now - 601 unknown; a calling run 180 s old ok, 181 s unknown', () => {
    const at = (obs: number, lastCalling: number) => classifyAvailability({ ...base, lastCalling, latestObs: new Map([['BTC', obs]]) }).BTC.state;
    expect(at(NOW - 600, NOW - 60)).toBe('ok');
    expect(at(NOW - 601, NOW - 60)).toBe('unknown');
    expect(at(NOW - 30, NOW - 180)).toBe('ok');
    expect(at(NOW - 30, NOW - 181)).toBe('unknown');
  });

  it('unknown with no calling run (record = 0), a newest whole-key failure, or no latest row', () => {
    expect(classifyAvailability({ ...base, lastCalling: null, latestObs: fresh }).BTC.state).toBe('unknown');
    expect(classifyAvailability({ ...base, newestKeyFailure: 1, latestObs: fresh }).BTC.state).toBe('unknown');
    expect(classifyAvailability({ ...base, latestObs: new Map() }).BTC.state).toBe('unknown');
  });

  it('refused: a feeds_refused symbol without a hold, and a hold on a fresh feed (with since and source)', () => {
    const a = classifyAvailability({ ...base, feedsRefused: ['BAC'], holds: [{ symbol: 'AAPL', since: NOW - 5, source: 'tick' }], latestObs: fresh });
    expect(a.BAC).toEqual({ state: 'refused' });
    expect(a.AAPL).toEqual({ state: 'refused', since: NOW - 5, source: 'tick' });
  });

  it('on D1: checkedAtS is D1 clock; a recent calling run and a fresh latest give ok; serve = 0 still answers', async () => {
    const now = await d1Now();
    await db().batch([
      db().prepare('INSERT INTO runs (t, calls, key_failure) VALUES (?1, 34, 0)').bind(now - 30),
      db().prepare("INSERT INTO latest (feed, price, obs) VALUES ('BTC', '1', ?1)").bind(now - 30),
      db().prepare("INSERT INTO feed_holds (symbol, since, source) VALUES ('AAPL', ?1, 'operator')").bind(now - 10),
    ]);
    const r = await body(await get('/v1/availability'));
    expect(Math.abs((r.checkedAtS as number) - now)).toBeLessThanOrEqual(2);
    const s = r.symbols as Record<string, { state: string }>;
    expect(s.BTC.state).toBe('ok');
    expect(s.ETH.state).toBe('unknown');
    expect(s.BAC.state).toBe('refused');
    expect(s.AAPL).toEqual({ state: 'refused', since: now - 10, source: 'operator' });
  });
});

describe('health (12)', () => {
  it('per feed, holds with servedLast10m, the checker and the switches; answers while serve = 0', async () => {
    const now = await d1Now();
    await store([openMinute(H)], H + 60);
    await db().batch([
      db().prepare("INSERT INTO latest (feed, price, obs) VALUES ('AAPL', '1', ?1)").bind(now - 30),
      db().prepare("INSERT INTO feed_holds (symbol, since, source) VALUES ('AAPL', ?1, 'tick'), ('TSLA', ?1, 'operator')").bind(now - 100),
      db().prepare("INSERT INTO todo (feed, hour) VALUES ('ETH', ?1), ('ETH', ?2)").bind(H - HOUR, H - 2 * HOUR),
      db().prepare('INSERT INTO runs (t, calls, n_429) VALUES (?1, 10, 1)').bind(now - 500),
    ]);
    const r = await body(await get('/v1/health'));
    expect(r.config).toMatchObject({ serve: 0, record: 0, feeds_refused: ['BAC', 'MA'] });
    expect(r.last429).toBe(now - 500);
    const feeds = r.feeds as Record<string, Record<string, unknown>>;
    expect(feeds.BTC.newestMinute).toBe(H);
    expect(feeds.ETH.queuedHours).toBe(2);
    expect(r.holds).toEqual([
      { symbol: 'AAPL', since: now - 100, source: 'tick', servedLast10m: true },
      { symbol: 'TSLA', since: now - 100, source: 'operator', servedLast10m: false },
    ]);
    expect(r.checker).toEqual({ lastCompleted: null, current: null });
  });
});

describe('the read path writes nothing', () => {
  const sources = import.meta.glob<string>('../src/read.ts', { eager: true, query: '?raw', import: 'default' });
  it('read.ts holds no INSERT, UPDATE, DELETE or REPLACE', () => {
    const text = Object.values(sources)[0];
    expect(text).toBeDefined();
    expect(text).not.toMatch(/\b(INSERT|UPDATE|DELETE|REPLACE)\b/);
  });
});
