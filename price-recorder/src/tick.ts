// ----------------------------------------------------------------------------
// price-recorder/src/tick.ts
//
// One minute tick (CHARTS_DS_PLAN 4.2): bounded reads, then ONE write transaction.
//   1. read `config` (fail closed, section 11): an invalid row (no row, a wrong type, a D1 error, no binding) writes
//      nothing and calls nothing. Then take the lease (4.4); not acquired: `lease_busy`, exit.
//      `record = 0` (the kill switch): no Data Streams call; the batch writes only the `runs` row (calls = 0), so
//      /v1/availability turns every symbol `unknown` within 3 minutes (8.6, section 11).
//   2. one state read (backfill.ts): the backfill units (section 6), whether a 429 was seen in the last 10 minutes,
//      whether the gap scan must fill `todo` now (first start), and the checker's open cycle and shard (3.6).
//   3. fetch the live minute of every feed not in `config.feeds_refused`, then the live catch-up (3.4), then on the
//      hourly tick one restoration probe per listed feed (4.1), then the backfill units; build the 1m rows and the
//      `latest` candidates in memory (backfill never writes `latest`). The live minute M is the newest minute that
//      ended >= 30 s ago; catch-up takes every minute of the 10 before it that has no row or an `incomplete` row,
//      oldest first.
//   4. two reads: the stored 1m rows of the hours the tick can touch (read before fetching, because catch-up needs
//      them, and complete for every hour live, catch-up and backfill touch), and the stored 1h rows of the touched
//      days; and, before fetching, the checker's two shard reads (checker.ts).
//   5. merge and recompute (plan.ts), with the horizon = the end of the live minute (the newest minute built), never
//      the wall clock.
//   6. one batch: fence, 1m, 15m, 1h, 1d, conflict evidence (only when there is some), the `latest` drop for minutes
//      that became `conflict` and the `latest` upsert, the `runs` row, the `feed_holds` insert (only in a tick that saw
//      a per-feed refusal), the hourly pruning statement, the finished and tried `todo` units, the gap scan (hourly,
//      or on a first-start tick), the checker's result and cursor (or a new cycle, or its stuck count), the guard
//      delete, the release. Sent only if the worker's
//      clock shows at most 58 s since just before the lease was taken (`deadline` otherwise, nothing written).
// Refusals (4.1): a per-feed refusal leaves that feed's minutes of the tick `incomplete` (its pages are discarded),
// makes no further request for it, lists it in `runs.unauthorized` and holds it (add-only). Any other 401/403 body is a
// whole-key failure, and so is a tick whose every answered live page is a per-feed refusal: no further calls,
// `key_failure = 1`, nothing listed and no hold. A 429 stops every further call too.
// ----------------------------------------------------------------------------

import type { HmacHex, ReportCredentials } from '../../cf-worker/src/datastreams';
import { buildMinute, type MinuteRow } from './candle';
import { BACKFILL_PAGE_CAP, gapScan, PROBE_LOOKBACK_S, readTickState, todoWrites, unitBudget, unitOutcomes, type Unit } from './backfill';
import { checkShard, parseOpenCycle, resultWrites, startCycle, stuckWrite, STUCK_TICKS } from './checker';
import { pageClient, type PageClient, type PageResult } from './client';
import { readConfig } from './config';
import { candleWrites, pruneStatement, readHoursOfDays, readMinutesOfHours } from './db';
import { fetchMinutes, minuteInputs, validOnce, type FeedFetch } from './fetcher';
import { FEEDS, type Feed } from './feeds';
import { acquireLease, D1_NOW, fence, guardDelete, release, stillHeld } from './lease';
import { BATCH_DEADLINE_MS, CATCHUP_PAGE_CAP, Limiter, LIVE_PAGE_CAP, realClock, type Clock } from './limiter';
import type { StoredMinute } from './merge';
import { planTick, touchedDays, touchedHours, type Span } from './plan';
import { align, HOUR } from './rollup';
import { MINUTE_S } from './rules';

/// The resolver's Data Streams host (`cf-worker/src/crypto-datastreams.ts` DEFAULT_DATASTREAMS_URL; a test keeps the
/// two equal).
export const DEFAULT_DATASTREAMS_URL = 'https://api.testnet-dataengine.chain.link';

/// Plan 3.4: a minute is fetched live once it ended at least 30 s ago, and caught up while within the last 10 minutes.
export const LIVE_DELAY_S = 30;
export const CATCHUP_MINUTES = 10;

export type LatestRow = { feed: string; price: string; obs: number; last_update_ns: string | null; market_status: number | null };

export const LATEST_DROP_SQL =
  `DELETE FROM latest WHERE EXISTS (SELECT 1 FROM json_each(?1) j WHERE json_extract(j.value, '$.feed') = latest.feed ` +
  `AND latest.obs >= json_extract(j.value, '$.t') AND latest.obs < json_extract(j.value, '$.t') + ${MINUTE_S})`;

export const LATEST_UPSERT_SQL =
  `INSERT INTO latest (feed, price, obs, last_update_ns, market_status) SELECT json_extract(value, '$.feed'), ` +
  `json_extract(value, '$.price'), json_extract(value, '$.obs'), json_extract(value, '$.last_update_ns'), ` +
  `json_extract(value, '$.market_status') FROM json_each(?1) WHERE true ON CONFLICT(feed) DO UPDATE SET ` +
  `price = excluded.price, obs = excluded.obs, last_update_ns = excluded.last_update_ns, market_status = excluded.market_status ` +
  `WHERE excluded.obs > latest.obs`;

/// One row per tick. `t` is D1's clock, moved one second past the newest row if a row already has that second, so two
/// ticks in one second (a manual run) never collide on the primary key and roll their batch back.
export const RUNS_INSERT_SQL =
  `INSERT INTO runs (t, calls, n_429, rejected, incomplete, conflicts, lag_s, unauthorized, key_failure) ` +
  `SELECT MAX(${D1_NOW}, COALESCE((SELECT MAX(t) FROM runs), 0) + 1), ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8`;

/// Plan 4.2 step 6, verbatim: add-only, the same symbols as `runs.unauthorized`.
export const HOLD_INSERT_SQL =
  `INSERT INTO feed_holds (symbol, since, source) SELECT value, ${D1_NOW}, 'tick' FROM json_each(?1) WHERE true ON CONFLICT(symbol) DO NOTHING`;

export type RunRow = { calls: number; n_429: number; rejected: number; incomplete: number; conflicts: number; lag_s: number | null; unauthorized: string[]; key_failure: 0 | 1 };

const runsInsert = (db: D1Database, r: RunRow) =>
  db.prepare(RUNS_INSERT_SQL).bind(r.calls, r.n_429, r.rejected, r.incomplete, r.conflicts, r.lag_s, JSON.stringify(r.unauthorized), r.key_failure);

export type TickDeps = {
  db: D1Database | undefined;
  fetchImpl: typeof fetch;
  base: string;
  /// Null when the Worker has no Data Streams secrets.
  creds: ReportCredentials | null;
  clock?: Clock;
  hmac?: HmacHex;
  timeoutMs?: number;
  holder?: () => string;
  log?: (event: Record<string, unknown>) => void;
};

export type TickOutcome =
  | 'config_invalid'
  | 'lease_busy'
  | 'idle'
  | 'no_credentials'
  | 'recorded'
  | 'deadline'
  | 'lease_lost'
  | 'batch_failed'
  | 'tick_failed';

export type TickReport = {
  outcome: TickOutcome;
  recovered: boolean;
  /// The live minute, when the tick recorded.
  minute: number | null;
  run: RunRow | null;
  /// Statements of the write batch (0 when nothing was sent).
  batchStatements: number;
};

/// Plan 3.4: the live minute M at worker time `nowS`, the newest minute that ended at least 30 s ago.
export const liveMinute = (nowS: number): number => align(nowS - LIVE_DELAY_S - MINUTE_S, MINUTE_S);

/// The catch-up window: the CATCHUP_MINUTES minutes before M, oldest first.
export const catchupWindow = (M: number): number[] => Array.from({ length: CATCHUP_MINUTES }, (_, i) => M - (CATCHUP_MINUTES - i) * MINUTE_S);

/// Plan 3.1 latestCandidate: among the feed's live pages, the valid entry with the greatest obs, unless two different
/// valid entries share that second (then nothing is written this tick, 8.2).
export function latestCandidate(feed: Feed, entries: readonly unknown[]): LatestRow | null {
  let best: number | null = null;
  const keys = new Set<string>();
  let row: LatestRow | null = null;
  for (const e of entries) {
    if (e === null || typeof e !== 'object' || Array.isArray(e)) continue;
    const v = validOnce(e as Record<string, unknown>, feed);
    if (v === null) continue;
    if (best === null || v.obs > best) {
      best = v.obs;
      keys.clear();
    } else if (v.obs < best) continue;
    keys.add(v.key);
    const r = v.report;
    row = {
      feed: feed.symbol,
      price: v.price.toString(),
      obs: v.obs,
      last_update_ns: r.schema === 8 ? r.lastUpdateTimestamp.toString() : null,
      market_status: r.schema === 8 ? r.marketStatus : null,
    };
  }
  return keys.size === 1 ? row : null;
}

const answered = (r: PageResult) => r.status !== 0;

/// One tick. Never throws.
export async function runTick(deps: TickDeps): Promise<TickReport> {
  const clock = deps.clock ?? realClock;
  const log = deps.log ?? ((e) => console.log(JSON.stringify(e)));
  const report: TickReport = { outcome: 'config_invalid', recovered: false, minute: null, run: null, batchStatements: 0 };
  const done = (outcome: TickOutcome, extra: Record<string, unknown> = {}): TickReport => {
    report.outcome = outcome;
    log({ event: outcome, minute: report.minute, recovered: report.recovered, ...(report.run ?? {}), batchStatements: report.batchStatements, ...extra });
    return report;
  };

  const db = deps.db;
  const cfg = await readConfig(db);
  if (!cfg.valid || !db) return done('config_invalid', { reason: cfg.valid ? 'no D1 binding' : cfg.reason });

  // Plan 4.4: every deadline is measured on the worker from just before the lease statement is sent.
  const t0 = clock.now();
  const holder = (deps.holder ?? (() => crypto.randomUUID()))();
  let lease;
  try {
    lease = await acquireLease(db, holder);
  } catch (e) {
    return done('tick_failed', { stage: 'lease', error: e instanceof Error ? e.name : 'error' });
  }
  if (!lease.acquired) return done('lease_busy');
  report.recovered = lease.recovered;
  if (lease.recovered) log({ event: 'lease_recovered' });

  const commit = async (writes: D1PreparedStatement[], outcome: TickOutcome): Promise<TickReport> => {
    const stmts = [fence(db, holder), ...writes, guardDelete(db), release(db, holder)];
    if (clock.now() - t0 > BATCH_DEADLINE_MS) return done('deadline');
    report.batchStatements = stmts.length;
    try {
      await db.batch(stmts);
    } catch (e) {
      const held = await stillHeld(db, holder).catch(() => true);
      return done(held ? 'batch_failed' : 'lease_lost', { error: e instanceof Error ? e.name : 'error' });
    }
    return done(outcome);
  };

  try {
    if (cfg.config.record !== 1) {
      report.run = { calls: 0, n_429: 0, rejected: 0, incomplete: 0, conflicts: 0, lag_s: null, unauthorized: [], key_failure: 0 };
      return await commit([runsInsert(db, report.run)], 'idle');
    }
    if (!deps.creds) {
      report.run = { calls: 0, n_429: 0, rejected: 0, incomplete: 0, conflicts: 0, lag_s: null, unauthorized: [], key_failure: 1 };
      return await commit([runsInsert(db, report.run)], 'no_credentials');
    }

    const M = liveMinute(Math.floor(t0 / 1000));
    report.minute = M;
    const refusedByConfig = new Set(cfg.config.feeds_refused);
    const feeds = FEEDS.filter((f) => !refusedByConfig.has(f.symbol));
    const window = [...catchupWindow(M), M];
    const horizon = M + MINUTE_S;

    // Step 2: the state read; backfill units beyond this tick's budget wait.
    const st = await readTickState(db, cfg.config.feeds_refused, horizon, cfg.config.p_bf);
    const units: Unit[] = st.units.slice(0, unitBudget(cfg.config.p_bf, st.recent429));
    const hourly = M % HOUR === 0;

    // Step 4, first read: every stored 1m row of the hours live, catch-up and backfill can touch.
    const windowHours: Span[] = [
      ...feeds.flatMap((f) => [...new Set(window.map((t) => align(t, HOUR)))].map((start) => ({ feed: f.symbol, start }))),
      ...units.map((u) => ({ feed: u.feed, start: u.hour })),
    ];
    const stored = await readMinutesOfHours(db, windowHours);

    // The checker's shard (3.6), read now so its reads never meet the batch deadline. A read or parse failure is not a
    // result: the shard stays where it is and is retried next tick.
    const cycle = parseOpenCycle(st.checker);
    const checkerWrites: D1PreparedStatement[] = [];
    if (cycle === null) checkerWrites.push(...startCycle(db, horizon));
    else {
      let ok = false;
      if (cycle.feed !== null && cycle.day !== null) {
        try {
          const r = await checkShard(db, cycle.feed, cycle.day, horizon);
          checkerWrites.push(...resultWrites(db, cycle, r));
          ok = true;
          if (r.status === 'diff') log({ event: 'checker_diff', cycle: cycle.id, ordinal: cycle.next, feed: cycle.feed, day: cycle.day, first: r.first_diff });
        } catch (e) {
          log({ event: 'checker_read_failed', cycle: cycle.id, ordinal: cycle.next, error: e instanceof Error ? e.name : 'error' });
        }
      }
      if (!ok) {
        checkerWrites.push(stuckWrite(db, cycle));
        if (cycle.stuck + 1 >= STUCK_TICKS) log({ event: 'checker_stuck', cycle: cycle.id, ordinal: cycle.next, ticks: cycle.stuck + 1 });
      }
    }
    const storedBy = new Map<string, StoredMinute>(stored.map((m) => [`${m.feed}:${m.t}`, m]));

    // Step 3: fetch. A 429 or a whole-key failure halts the limiter, so every chain still waiting stops. A 429 halts on
    // its status, before its body is cancelled, so no call in flight can free a slot for another call first.
    const limiter = new Limiter(clock, t0);
    const onStatus = (s: number) => {
      if (s === 429) limiter.halt('rate_limited');
    };
    const mayStart = () => limiter.halted === null;
    const raw = pageClient({ fetchImpl: deps.fetchImpl, base: deps.base, creds: deps.creds, now: () => clock.now(), hmac: deps.hmac, timeoutMs: deps.timeoutMs, onStatus, mayStart });
    const client: PageClient = async (feedId, start) => {
      const r = await raw(feedId, start);
      if (r.kind === 'key_failure' || r.kind === 'rate_limited') limiter.halt(r.kind);
      return r;
    };
    const ctx = { limiter, client };

    const live = await Promise.all(feeds.map((f) => fetchMinutes(ctx, f, [M], LIVE_PAGE_CAP)));
    const liveAnswers = live.flatMap((r) => r.answers).filter(answered);
    const allLiveRefused = liveAnswers.length > 0 && liveAnswers.every((r) => r.kind === 'feed_refused');
    if (allLiveRefused) limiter.halt('key_failure');

    const catchup: (FeedFetch | null)[] = await Promise.all(
      feeds.map((f, i) => {
        if (limiter.halted !== null || live[i].stop === 'feed_refused') return null;
        const targets = catchupWindow(M).filter((t) => {
          const s = storedBy.get(`${f.symbol}:${t}`);
          return s === undefined || s.state === 'incomplete';
        });
        return targets.length > 0 ? fetchMinutes(ctx, f, targets, CATCHUP_PAGE_CAP) : null;
      }),
    );

    const refusedNow = (i: number) => [live[i], catchup[i]].some((r) => r?.answers.some((a) => a.kind === 'feed_refused'));

    // Plan 4.1: on the hourly tick, one restoration probe per feed in config.feeds_refused. A 200 with a valid entry
    // is logged `feed_restored`; the operator then lifts the listing.
    const restored: string[] = [];
    if (hourly) {
      const probeFrom = Math.floor(clock.now() / 1000) - PROBE_LOOKBACK_S;
      await Promise.all(
        FEEDS.filter((f) => refusedByConfig.has(f.symbol)).map(async (f) => {
          if (limiter.halted !== null) return;
          const res = await limiter.run(() => client(f.feedId, probeFrom));
          if (!res.ran) return;
          if (res.value.kind === 'unsent') limiter.notSent();
          else if (res.value.kind === 'ok' && res.value.reports.some((e) => e !== null && typeof e === 'object' && !Array.isArray(e) && validOnce(e as Record<string, unknown>, f) !== null)) restored.push(f.symbol);
        }),
      );
      for (const symbol of restored) log({ event: 'feed_restored', symbol });
    }

    // Section 6: the backfill units, after live and catch-up. A unit of a feed refused this tick is skipped.
    const feedIndex = new Map(feeds.map((f, i) => [f.symbol, i]));
    const backfill: (FeedFetch | null)[] = await Promise.all(
      units.map((u) => {
        const i = feedIndex.get(u.feed);
        if (i === undefined || limiter.halted !== null || refusedNow(i)) return null;
        const minutes = Array.from({ length: HOUR / MINUTE_S }, (_, k) => u.hour + k * MINUTE_S);
        return fetchMinutes(ctx, feeds[i], minutes, BACKFILL_PAGE_CAP);
      }),
    );

    const allAnswers = [...live, ...catchup, ...backfill].flatMap((r) => r?.answers ?? []);
    const keyFailure = allLiveRefused || allAnswers.some((r) => r.kind === 'key_failure');
    const refused = new Set<string>();
    feeds.forEach((f, i) => {
      if (refusedNow(i)) refused.add(f.symbol);
    });
    units.forEach((u, k) => {
      if (backfill[k]?.answers.some((a) => a.kind === 'feed_refused')) refused.add(u.feed);
    });

    // Build the 1m rows and the latest candidates.
    const built: MinuteRow[] = [];
    const candidates: LatestRow[] = [];
    feeds.forEach((f, i) => {
      if (refused.has(f.symbol)) {
        built.push(buildMinute(f, M, [], true)); // the request proves nothing: incomplete
        return;
      }
      const chains = [...live[i].chains, ...(catchup[i]?.chains ?? [])];
      for (const c of chains) for (const t of c.minutes) built.push(buildMinute(f, t, minuteInputs(f, t, c.entries), c.ok));
      for (let k = 0; k < units.length; k++) {
        if (units[k].feed !== f.symbol) continue;
        for (const c of backfill[k]?.chains ?? []) for (const t of c.minutes) built.push(buildMinute(f, t, minuteInputs(f, t, c.entries), c.ok));
      }
      if (!live[i].chains.some((c) => c.minutes.includes(M))) built.push(buildMinute(f, M, [], true));
      const liveOk = live[i].chains.filter((c) => c.ok);
      if (liveOk.length === live[i].chains.length) {
        const cand = latestCandidate(f, liveOk.flatMap((c) => c.entries));
        if (cand) candidates.push(cand);
      }
    });

    // Steps 4 (second read) and 5.
    const TH = new Set(touchedHours(built).map((s) => `${s.feed}:${s.start}`));
    const storedTH = stored.filter((m) => TH.has(`${m.feed}:${align(m.t, HOUR)}`));
    const stored1h = await readHoursOfDays(db, touchedDays(built));
    const plan = planTick(built, storedTH, stored1h, horizon);

    const conflicted = plan.merges.filter((m) => m.becameConflict).map((m) => ({ feed: m.feed, t: m.t }));
    const inConflict = (c: LatestRow) => conflicted.some((m) => m.feed === c.feed && c.obs >= m.t && c.obs < m.t + MINUTE_S);
    const latest = candidates.filter((c) => !inConflict(c));
    const unauthorized = keyFailure ? [] : [...refused].sort();

    report.run = {
      calls: limiter.calls,
      n_429: allAnswers.filter((r) => r.kind === 'rate_limited').length,
      rejected: plan.rejected,
      incomplete: built.filter((r) => r.state === 'incomplete').length,
      conflicts: conflicted.length,
      lag_s: Math.floor(clock.now() / 1000) - (M + MINUTE_S),
      unauthorized,
      key_failure: keyFailure ? 1 : 0,
    };

    const writes: D1PreparedStatement[] = [...candleWrites(db, plan)];
    if (conflicted.length > 0) writes.push(db.prepare(LATEST_DROP_SQL).bind(JSON.stringify(conflicted)));
    if (latest.length > 0) writes.push(db.prepare(LATEST_UPSERT_SQL).bind(JSON.stringify(latest)));
    writes.push(runsInsert(db, report.run));
    if (unauthorized.length > 0) writes.push(db.prepare(HOLD_INSERT_SQL).bind(JSON.stringify(unauthorized)));
    if (hourly) writes.push(pruneStatement(db, M).stmt);
    // A unit of a refused feed counts as not run (plan 4.1: its tries unchanged).
    const pages = units.map((u, k) => (refused.has(u.feed) ? 0 : (backfill[k]?.pages ?? 0)));
    const { done, tried } = unitOutcomes(units, pages, plan.hours);
    writes.push(...todoWrites(db, [...done, ...st.stale], tried));
    if (hourly || st.needFill) writes.push(gapScan(db, feeds.map((f) => f.symbol), horizon));
    writes.push(...checkerWrites);
    if (units.length > 0 || done.length > 0) log({ event: 'backfill', units: units.length, done: done.length, tried: tried.length });
    return await commit(writes, 'recorded');
  } catch (e) {
    // A failed read or a bug: nothing was written, and the lease expires by itself (plan 4.4).
    return done('tick_failed', { error: e instanceof Error ? e.name : 'error' });
  }
}
