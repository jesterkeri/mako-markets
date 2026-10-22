// ----------------------------------------------------------------------------
// price-recorder/src/read.ts
//
// The read API (CHARTS_DS_PLAN 7.2, 8.2, 8.6, 11, 12; unit e). Server to server only: the app calls it with a token;
// no browser does, so no CORS header is ever sent. Every answer is JSON with `Cache-Control: no-store`.
//   GET /v1/candles?s=SYMBOL&tf=1m|15m|1h|2h|4h|1d   (serve = 1)
//   GET /v1/latest?s=SYMBOL                          (serve = 1)
//   GET /v1/availability                             (any valid config: pool creation must not follow the chart switch)
//   GET /v1/health                                   (any valid config: the operator needs it while serve = 0)
// Order of checks on every read (7.2, 11): (1) config, read first and fail closed: an invalid read answers 503 before
// any auth, so the state can be checked without a token (`charts_disabled` for candles and latest, which also need
// serve = 1; `config_invalid` for availability and health); (2) the token, `Authorization: Bearer <RECORDER_READ_TOKEN>`
// compared in constant time (Cloudflare's timingSafeEqual pattern); a Worker without the secret answers 503; (3) the
// inputs, symbol in the feed tables and tf an enum, else 400.
// ----------------------------------------------------------------------------

import { readConfig, type ConfigRead } from './config';
import { isInt, parseBucket, parseStoredMinute } from './db';
import { FEED_BY_SYMBOL, FEEDS } from './feeds';
import { D1_NOW } from './lease';
import { align, DAY, drawableAt, HOUR, rollupDay, rollupWide, WIDTH, type Bucket, type Timeframe } from './rollup';
import { MINUTE_S } from './rules';

export type ReadEnv = { DB?: D1Database; RECORDER_READ_TOKEN?: string };

/// 7.2: at most 300 slots (candles and gaps) per answer, the Coinbase answer size.
export const MAX_CANDLES = 300;
/// 8.6: a feed is available only with a valid report from the last 10 minutes and a calling tick in the last 3.
export const LATEST_FRESH_S = 600;
export const CALLING_TICK_S = 180;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/// Cloudflare's constant-time comparison: timingSafeEqual throws on unequal lengths, so a length mismatch compares the
/// input with itself and negates, with no early return (developers.cloudflare.com/workers/examples/protect-against-timing-attacks/).
function tokenMatches(header: string | null, secret: string): boolean {
  const enc = new TextEncoder();
  const given = enc.encode(header ?? '');
  const want = enc.encode(`Bearer ${secret}`);
  return given.byteLength === want.byteLength ? crypto.subtle.timingSafeEqual(given, want) : !crypto.subtle.timingSafeEqual(given, given);
}

/// Steps (1) and (2) of every read. Returns the config, or the answer to send.
async function gate(req: Request, env: ReadEnv, needServe: boolean): Promise<{ cfg: Extract<ConfigRead, { valid: true }>['config'] } | { res: Response }> {
  const cfg = await readConfig(env.DB);
  if (!cfg.valid || !env.DB) return { res: json({ error: needServe ? 'charts_disabled' : 'config_invalid' }, 503) };
  if (needServe && cfg.config.serve !== 1) return { res: json({ error: 'charts_disabled' }, 503) };
  const secret = env.RECORDER_READ_TOKEN?.trim();
  if (!secret) return { res: json({ error: 'not_configured' }, 503) };
  if (!tokenMatches(req.headers.get('authorization'), secret)) return { res: json({ error: 'unauthorized' }, 401) };
  return { cfg: cfg.config };
}

const TIMEFRAMES: readonly string[] = ['1m', '15m', '1h', '2h', '4h', '1d'];
const BUCKET_TABLE: Readonly<Record<'15m' | '1h' | '1d', string>> = { '15m': 'candles_15m', '1h': 'candles_1h', '1d': 'candles_1d' };

export type Candle = { t: number; o: string; h: string; l: string; c: string };

/// A slot of the answer: a candle, a gap (missing or unusable data, drawn as an empty slot) or nothing (closed time,
/// which collapses on the chart, section 10).
type Slot = { kind: 'candle'; candle: Candle } | { kind: 'gap' } | { kind: 'closed' };

function bucketSlot(b: Bucket, width: number, horizon: number): Slot {
  if (drawableAt(b, width, horizon)) return { kind: 'candle', candle: { t: b.t, o: b.o!, h: b.h!, l: b.l!, c: b.c! } };
  const ended = b.t + width <= horizon;
  // Only closed minutes so far, nothing missing: closed time, not a gap.
  if (b.n_min_open === 0 && b.n_min_gap === 0 && (!ended || b.n_min_retry === 0)) return { kind: 'closed' };
  return { kind: 'gap' };
}

/// A 1h row as a sub-bucket of a wider one (2h, 4h, today's 1d), at the read horizon. A stored row was computed at the
/// horizon of the tick that last wrote it; an hour written while forming and never touched again keeps n_min_gap = 0
/// for minutes that have since elapsed without a row (the case `drawableAt` handles for the row itself). Once the hour
/// has ended, its missing or incomplete minutes (n_min_retry) count as gaps, so a wider bucket holding it is not drawn
/// (adversary on unit e). Only the gap decision uses the sum, never as a count.
const subHourAt = (b: Bucket, horizon: number): Bucket => (b.t + HOUR <= horizon && b.n_min_retry > 0 ? { ...b, n_min_gap: b.n_min_gap + b.n_min_retry } : b);

/// The slots of [start, end] for one timeframe, keyed by bucket start.
async function slotsIn(db: D1Database, symbol: string, tf: Timeframe | '1m', start: number, end: number, asOf: number): Promise<Map<number, Slot>> {
  const width = tf === '1m' ? MINUTE_S : WIDTH[tf];
  const slots = new Map<number, Slot>();
  if (tf === '1m') {
    const res = await db.prepare('SELECT * FROM candles_1m WHERE feed = ?1 AND t >= ?2 AND t <= ?3').bind(symbol, start, end).all<Record<string, unknown>>();
    for (const m of res.results.map(parseStoredMinute)) {
      slots.set(m.t, m.state === 'open' ? { kind: 'candle', candle: { t: m.t, o: m.o!, h: m.h!, l: m.l!, c: m.c! } } : m.state === 'closed' ? { kind: 'closed' } : { kind: 'gap' });
    }
    return slots;
  }
  const wide = tf === '2h' || tf === '4h';
  const table = wide ? 'candles_1h' : BUCKET_TABLE[tf];
  const res = await db.prepare(`SELECT * FROM ${table} WHERE feed = ?1 AND t >= ?2 AND t < ?3`).bind(symbol, start, end + width).all<Record<string, unknown>>();
  const rows = res.results.map(parseBucket);
  const buckets = wide ? rollupWide(symbol, tf === '2h' ? 2 : 4, rows.map((b) => subHourAt(b, asOf)), asOf) : rows;
  for (const b of buckets) slots.set(b.t, bucketSlot(b, width, asOf));
  if (tf === '1d' && end + DAY > asOf) {
    // Today's stored 1d row has the same blind spot as a wide bucket: rebuild it from today's 1h rows at the read horizon.
    const hours = await db.prepare('SELECT * FROM candles_1h WHERE feed = ?1 AND t >= ?2 AND t < ?2 + 86400').bind(symbol, end).all<Record<string, unknown>>();
    const today = hours.results.map(parseBucket);
    if (today.length > 0) slots.set(end, bucketSlot(rollupDay(symbol, end, today.map((b) => subHourAt(b, asOf)), asOf), DAY, asOf));
  }
  return slots;
}

/// 7.2 and section 10: the newest MAX_CANDLES slots (candles and gaps) up to the bucket holding the newest recorded
/// minute. Closed time produces no slot and so takes none of the 300 (a stock's 1m chart overnight, a forex chart at the
/// weekend still shows the last session): the window doubles backwards until it holds 300 slots or reaches the feed's
/// first stored row (adversary on unit e). Missing or unusable data is a gap; no gaps before the first stored row.
/// Reads per request: the final window, once. Worst cases: 1m at most the 35 days of kept rows (50,400); 2h and 4h at
/// most the feed's 1h history; a feed with open data in the last 300 slots reads about 300 rows (2h: 600, 4h: 1,200).
export const MAX_WINDOW_DOUBLINGS = 8;
export async function candles(db: D1Database, symbol: string, tf: Timeframe | '1m'): Promise<{ candles: Candle[]; gaps: number[]; asOf: number | null; marketOpen: boolean | null }> {
  const newest = await db.prepare('SELECT t, state FROM candles_1m WHERE feed = ?1 ORDER BY t DESC LIMIT 1').bind(symbol).first<{ t: number; state: string }>();
  if (!newest) return { candles: [], gaps: [], asOf: null, marketOpen: null };
  const asOf = newest.t + MINUTE_S;
  const isCrypto = FEED_BY_SYMBOL.get(symbol)?.class === 'crypto';
  const marketOpen = isCrypto ? null : newest.state === 'open' ? true : newest.state === 'closed' ? false : null;
  const width = tf === '1m' ? MINUTE_S : WIDTH[tf];
  const end = align(newest.t, width);
  const sourceTable = tf === '1m' ? 'candles_1m' : tf === '2h' || tf === '4h' ? 'candles_1h' : BUCKET_TABLE[tf];
  const firstRow = await db.prepare(`SELECT MIN(t) AS t FROM ${sourceTable} WHERE feed = ?1`).bind(symbol).first<{ t: number | null }>();
  if (!firstRow || firstRow.t === null) return { candles: [], gaps: [], asOf, marketOpen };
  const floor = align(firstRow.t, width);

  // Each widening reads only the part not read yet, so a request reads at most its final window once.
  let span = MAX_CANDLES;
  let readFrom = end + width;
  const picked: { t: number; slot: Slot }[] = [];
  for (let i = 0; ; i++) {
    const start = Math.max(end - (span - 1) * width, floor);
    const slots = await slotsIn(db, symbol, tf, start, readFrom - width, asOf);
    for (let t = readFrom - width; t >= start && picked.length < MAX_CANDLES; t -= width) {
      const s = slots.get(t) ?? { kind: 'gap' };
      if (s.kind !== 'closed') picked.push({ t, slot: s });
    }
    readFrom = start;
    if (picked.length >= MAX_CANDLES || start <= floor || i >= MAX_WINDOW_DOUBLINGS) break;
    span *= 2;
  }
  picked.reverse();
  const out: Candle[] = [];
  const gaps: number[] = [];
  for (const { t, slot } of picked) {
    if (slot.kind === 'candle') out.push(slot.candle);
    else gaps.push(t);
  }
  return { candles: out, gaps, asOf, marketOpen };
}

/// 8.2: absolute timestamps only, no ages (the app classifies freshness with its own clock).
export async function latest(db: D1Database, symbol: string): Promise<{ price: string; obs: number; lastUpdateNs: string | null; marketStatus: number | null } | null> {
  const r = await db.prepare('SELECT price, obs, last_update_ns, market_status FROM latest WHERE feed = ?1').bind(symbol).first<Record<string, unknown>>();
  if (!r) return null;
  if (typeof r.price !== 'string' || !isInt(r.obs) || !(r.last_update_ns === null || typeof r.last_update_ns === 'string') || !(r.market_status === null || isInt(r.market_status))) {
    throw new Error('malformed latest row');
  }
  return { price: r.price, obs: r.obs, lastUpdateNs: r.last_update_ns, marketStatus: r.market_status };
}

export type Availability = { state: 'ok' | 'refused' | 'unknown'; since?: number; source?: string };

export type AvailabilityInputs = {
  now: number;
  holds: readonly { symbol: string; since: number; source: string }[];
  latestObs: ReadonlyMap<string, number>;
  feedsRefused: readonly string[];
  /// The newest runs row with a Data Streams call, and the newest runs row's key_failure (null: no runs row).
  lastCalling: number | null;
  newestKeyFailure: number | null;
};

/// 8.6, pure, by the first matching rule: refused (a hold, with its since and source; or listed in feeds_refused),
/// unknown (no calling tick in the last 180 s, the newest tick a whole-key failure, or no report in the last 600 s),
/// else ok. Every symbol of the two feed tables, nothing else.
export function classifyAvailability(x: AvailabilityInputs): Record<string, Availability> {
  const hold = new Map(x.holds.map((h) => [h.symbol, h]));
  const refused = new Set(x.feedsRefused);
  const tickOk = x.lastCalling !== null && x.lastCalling >= x.now - CALLING_TICK_S && x.newestKeyFailure !== 1;
  const out: Record<string, Availability> = {};
  for (const f of FEEDS) {
    const h = hold.get(f.symbol);
    const o = x.latestObs.get(f.symbol);
    if (h) out[f.symbol] = { state: 'refused', since: h.since, source: h.source };
    else if (refused.has(f.symbol)) out[f.symbol] = { state: 'refused' };
    else out[f.symbol] = { state: tickOk && o !== undefined && o >= x.now - LATEST_FRESH_S ? 'ok' : 'unknown' };
  }
  return out;
}

/// 8.6 on D1: three reads (holds, latest, and one statement for D1's clock and the two runs facts), then the rule.
export async function availability(db: D1Database, feedsRefused: readonly string[]): Promise<{ checkedAtS: number; symbols: Record<string, Availability> }> {
  const [holds, rows, runs] = await Promise.all([
    db.prepare('SELECT symbol, since, source FROM feed_holds').all<{ symbol: string; since: number; source: string }>(),
    db.prepare('SELECT feed, obs FROM latest').all<{ feed: string; obs: number }>(),
    db
      .prepare(
        `SELECT ${D1_NOW} AS now, (SELECT key_failure FROM runs ORDER BY t DESC LIMIT 1) AS newest_key_failure, ` +
          `(SELECT MAX(t) FROM runs WHERE calls > 0) AS last_calling`,
      )
      .first<{ now: number; newest_key_failure: number | null; last_calling: number | null }>(),
  ]);
  if (!runs || !isInt(runs.now)) throw new Error('clock read failed');
  const symbols = classifyAvailability({
    now: runs.now,
    holds: holds.results,
    latestObs: new Map(rows.results.map((r) => [r.feed, r.obs])),
    feedsRefused,
    lastCalling: runs.last_calling,
    newestKeyFailure: runs.newest_key_failure,
  });
  return { checkedAtS: runs.now, symbols };
}

/// Section 12: per feed, the newest minute, the last 24 h's gap rows and rows, and queued backfill hours; the last
/// 429; every hold with whether its feed has a report from the last 10 minutes; the checker's last completed cycle and
/// the current one's progress; the config's switches.
export async function health(db: D1Database, cfg: { serve: number; record: number; p_bf: number; feeds_refused: string[] }): Promise<Record<string, unknown>> {
  const [clock, mins, queued, holds, cycles] = await Promise.all([
    db.prepare(`SELECT ${D1_NOW} AS now, (SELECT MAX(t) FROM runs WHERE n_429 > 0) AS last_429, (SELECT MAX(t) FROM runs) AS last_run`).first<{ now: number; last_429: number | null; last_run: number | null }>(),
    db
      .prepare(
        `SELECT feed, MAX(t) AS newest, SUM(CASE WHEN t >= ${D1_NOW} - ${DAY} THEN 1 ELSE 0 END) AS rows24h, ` +
          `SUM(CASE WHEN t >= ${D1_NOW} - ${DAY} AND state NOT IN ('open', 'closed') THEN 1 ELSE 0 END) AS gaps24h FROM candles_1m GROUP BY feed`,
      )
      .all<{ feed: string; newest: number; rows24h: number; gaps24h: number }>(),
    db.prepare('SELECT feed, COUNT(*) AS n FROM todo GROUP BY feed').all<{ feed: string; n: number }>(),
    db
      .prepare(`SELECT h.symbol, h.since, h.source, EXISTS (SELECT 1 FROM latest l WHERE l.feed = h.symbol AND l.obs >= ${D1_NOW} - ${LATEST_FRESH_S}) AS served10m FROM feed_holds h`)
      .all<{ symbol: string; since: number; source: string; served10m: number }>(),
    db
      .prepare(
        `SELECT id, started_at, completed_at, shards_total, next_index, n_ok, n_diff, stuck FROM checker_cycle ` +
          `WHERE id = (SELECT MAX(id) FROM checker_cycle WHERE completed_at IS NOT NULL) OR id = (SELECT MAX(id) FROM checker_cycle WHERE completed_at IS NULL)`,
      )
      .all<Record<string, unknown>>(),
  ]);
  const m = new Map(mins.results.map((r) => [r.feed, r]));
  const q = new Map(queued.results.map((r) => [r.feed, r.n]));
  return {
    now: clock?.now ?? null,
    config: { serve: cfg.serve, record: cfg.record, p_bf: cfg.p_bf, feeds_refused: cfg.feeds_refused },
    lastRun: clock?.last_run ?? null,
    last429: clock?.last_429 ?? null,
    feeds: Object.fromEntries(FEEDS.map((f) => [f.symbol, { newestMinute: m.get(f.symbol)?.newest ?? null, rows24h: m.get(f.symbol)?.rows24h ?? 0, gaps24h: m.get(f.symbol)?.gaps24h ?? 0, queuedHours: q.get(f.symbol) ?? 0 }])),
    holds: holds.results.map((h) => ({ symbol: h.symbol, since: h.since, source: h.source, servedLast10m: h.served10m === 1 })),
    checker: {
      lastCompleted: cycles.results.find((c) => c.completed_at !== null) ?? null,
      current: cycles.results.find((c) => c.completed_at === null) ?? null,
    },
  };
}

/// The Worker's fetch handler.
export async function handleRead(req: Request, env: ReadEnv): Promise<Response> {
  const url = new URL(req.url);
  const route = url.pathname;
  if (!['/v1/candles', '/v1/latest', '/v1/availability', '/v1/health'].includes(route)) return json({ error: 'not_found' }, 404);
  if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
  const needServe = route === '/v1/candles' || route === '/v1/latest';
  try {
    const g = await gate(req, env, needServe);
    if ('res' in g) return g.res;
    const db = env.DB!;
    if (route === '/v1/availability') {
      if (url.search !== '') return json({ error: 'bad_request' }, 400);
      return json(await availability(db, g.cfg.feeds_refused));
    }
    if (route === '/v1/health') return json(await health(db, g.cfg));
    const s = url.searchParams.get('s') ?? '';
    if (!FEED_BY_SYMBOL.has(s)) return json({ error: 'bad_symbol' }, 400);
    if (g.cfg.feeds_refused.includes(s)) {
      return route === '/v1/candles' ? json({ candles: [], gaps: [], unavailable: 'feed_refused' }) : json({ unavailable: 'feed_refused' });
    }
    if (route === '/v1/latest') {
      const l = await latest(db, s);
      return l ? json(l) : json({ error: 'no_latest' }, 404);
    }
    const tf = url.searchParams.get('tf') ?? '';
    if (!TIMEFRAMES.includes(tf)) return json({ error: 'bad_timeframe' }, 400);
    return json(await candles(db, s, tf as Timeframe | '1m'));
  } catch (e) {
    console.log(JSON.stringify({ event: 'read_failed', route, error: e instanceof Error ? e.name : 'error' }));
    return json({ error: 'read_failed' }, 500);
  }
}
