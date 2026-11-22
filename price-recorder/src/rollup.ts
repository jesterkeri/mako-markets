// ----------------------------------------------------------------------------
// price-recorder/src/rollup.ts
//
// Rollups (CHARTS_DS_PLAN 3.5). Pure: no I/O, no clock.
//   * 15m and 1h from the 1m rows of the bucket (<= 15 and <= 60 rows); 1d from the 24 1h rows of the day, never
//     from 1m; 2h and 4h from 1h rows at read time. OHLC merges exactly under this nesting: open = the first open
//     sub-bucket's open, close = the last one's close, high = max, low = min, compared as bigint (prices are decimal
//     strings; the database never compares them).
//   * Coverage counters on every bucket:
//       n_min_open    open minutes
//       n_min_closed  closed minutes
//       n_min_gap     unknown, stale, empty, incomplete and conflict minutes, plus missing minutes that have
//                     elapsed (a minute M has elapsed when M + 60 <= horizon)
//       n_min_retry   missing minutes (elapsed or not) plus incomplete ones: the only ones re-queued (plan 6)
//     A minute that has a row is counted by its state whatever the horizon (a row exists only for a minute that was
//     built, so it has elapsed by the builder's clock).
//   * Drawable: n_min_gap = 0 and n_min_open > 0. Closed minutes never break a bucket. For 1d this is the plan's "every
//     elapsed hour has a 1h row with n_min_gap = 0 and at least one has open minutes", because a missing 1h row adds
//     its elapsed minutes to the day's n_min_gap.
// ----------------------------------------------------------------------------

import type { MinuteState } from './candle';

export const MINUTE = 60;
export const QUARTER = 900;
export const HOUR = 3600;
export const DAY = 86400;

/// What a rollup needs of a stored or freshly built 1m row.
export type MinuteCell = { t: number; state: MinuteState; o: string | null; h: string | null; l: string | null; c: string | null };

export type Bucket = {
  feed: string;
  t: number;
  o: string | null;
  h: string | null;
  l: string | null;
  c: string | null;
  n_min_open: number;
  n_min_closed: number;
  n_min_gap: number;
  n_min_retry: number;
};

export type Timeframe = '15m' | '1h' | '1d' | '2h' | '4h';
export const WIDTH: Readonly<Record<Timeframe, number>> = { '15m': QUARTER, '1h': HOUR, '1d': DAY, '2h': 2 * HOUR, '4h': 4 * HOUR };

/// floor(t / width) * width, also for negative t (UTC-aligned buckets).
export const align = (t: number, width: number): number => t - (((t % width) + width) % width);

/// Minutes of [start, start + span) that have elapsed at `horizon`.
export function elapsedMinutes(start: number, span: number, horizon: number): number {
  return Math.max(0, Math.min(span / MINUTE, Math.floor((horizon - start) / MINUTE)));
}

const GAP_STATES: ReadonlySet<MinuteState> = new Set(['unknown', 'stale', 'empty', 'incomplete', 'conflict']);

type Ohlc = { o: string; h: string; l: string; c: string };

/// Exact OHLC over parts in time order: open of the first, close of the last, bigint max and min.
function mergeOhlc(parts: readonly Ohlc[]): Ohlc | null {
  if (parts.length === 0) return null;
  let hi = BigInt(parts[0].h);
  let lo = BigInt(parts[0].l);
  for (const p of parts) {
    const h = BigInt(p.h);
    const l = BigInt(p.l);
    if (h > hi) hi = h;
    if (l < lo) lo = l;
  }
  return { o: parts[0].o, h: hi.toString(), l: lo.toString(), c: parts[parts.length - 1].c };
}

const ohlcOf = (x: { o: string | null; h: string | null; l: string | null; c: string | null }): Ohlc | null =>
  x.o !== null && x.h !== null && x.l !== null && x.c !== null ? { o: x.o, h: x.h, l: x.l, c: x.c } : null;

/// One bucket [start, start + span) from 1m rows. `minutes` may hold rows outside the bucket (ignored) but at most
/// one row per minute; a minute with no row is missing. Exact only when `minutes` holds EVERY stored row of the
/// bucket (plan 3.5 step 3).
export function bucketFromMinutes(feed: string, start: number, span: number, minutes: readonly MinuteCell[], horizon: number): Bucket {
  if (start % MINUTE !== 0 || span % MINUTE !== 0) throw new Error(`bucket ${start}+${span} is not minute-aligned`);
  const inside = minutes.filter((m) => m.t >= start && m.t < start + span).sort((a, b) => a.t - b.t);
  for (let i = 1; i < inside.length; i++) if (inside[i].t === inside[i - 1].t) throw new Error(`two rows for ${feed} ${inside[i].t}`);
  for (const m of inside) if (m.t % MINUTE !== 0) throw new Error(`row ${feed} ${m.t} is not minute-aligned`);
  let open = 0;
  let closed = 0;
  let gapRows = 0;
  let incomplete = 0;
  let elapsedMissing = 0;
  const parts: Ohlc[] = [];
  const have = new Set(inside.map((m) => m.t));
  for (let t = start; t < start + span; t += MINUTE) if (!have.has(t) && t + MINUTE <= horizon) elapsedMissing++;
  for (const m of inside) {
    if (m.state === 'open') {
      const p = ohlcOf(m);
      if (!p) throw new Error(`open row ${feed} ${m.t} without OHLC`);
      open++;
      parts.push(p);
    } else if (m.state === 'closed') closed++;
    else if (GAP_STATES.has(m.state)) {
      gapRows++;
      if (m.state === 'incomplete') incomplete++;
    } else throw new Error(`row ${feed} ${m.t} has unknown state ${String(m.state)}`);
  }
  const missing = span / MINUTE - inside.length;
  const ohlc = mergeOhlc(parts);
  return {
    feed,
    t: start,
    o: ohlc?.o ?? null,
    h: ohlc?.h ?? null,
    l: ohlc?.l ?? null,
    c: ohlc?.c ?? null,
    n_min_open: open,
    n_min_closed: closed,
    n_min_gap: gapRows + elapsedMissing,
    n_min_retry: missing + incomplete,
  };
}

/// One bucket [start, start + span) from the sub-buckets of width `subSpan` inside it (1d from 1h, 2h and 4h from
/// 1h). A missing sub-bucket counts as subSpan / 60 missing minutes: its elapsed ones in n_min_gap, all in n_min_retry.
export function bucketFromBuckets(feed: string, start: number, span: number, subSpan: number, subs: readonly Bucket[], horizon: number): Bucket {
  if (start % span !== 0 || span % subSpan !== 0) throw new Error(`bucket ${start}+${span} is not aligned to ${subSpan}`);
  const inside = subs.filter((b) => b.t >= start && b.t < start + span).sort((a, b) => a.t - b.t);
  for (let i = 1; i < inside.length; i++) if (inside[i].t === inside[i - 1].t) throw new Error(`two rows for ${feed} ${inside[i].t}`);
  for (const b of inside) if (b.t % subSpan !== 0) throw new Error(`row ${feed} ${b.t} is not aligned to ${subSpan}`);
  const have = new Set(inside.map((b) => b.t));
  let gap = 0;
  let retry = 0;
  let open = 0;
  let closed = 0;
  for (let t = start; t < start + span; t += subSpan) {
    if (have.has(t)) continue;
    gap += elapsedMinutes(t, subSpan, horizon);
    retry += subSpan / MINUTE;
  }
  const parts: Ohlc[] = [];
  for (const b of inside) {
    open += b.n_min_open;
    closed += b.n_min_closed;
    gap += b.n_min_gap;
    retry += b.n_min_retry;
    const p = ohlcOf(b);
    if (p) parts.push(p);
  }
  const ohlc = mergeOhlc(parts);
  return { feed, t: start, o: ohlc?.o ?? null, h: ohlc?.h ?? null, l: ohlc?.l ?? null, c: ohlc?.c ?? null, n_min_open: open, n_min_closed: closed, n_min_gap: gap, n_min_retry: retry };
}

/// The four 15m buckets and the 1h bucket of hour `hour`, from every 1m row of that hour (plan 3.5 step 5).
export function rollupHour(feed: string, hour: number, minutes: readonly MinuteCell[], horizon: number): { q: Bucket[]; h: Bucket } {
  if (hour % HOUR !== 0) throw new Error(`hour ${hour} is not aligned`);
  const q = [0, 1, 2, 3].map((i) => bucketFromMinutes(feed, hour + i * QUARTER, QUARTER, minutes, horizon));
  return { q, h: bucketFromMinutes(feed, hour, HOUR, minutes, horizon) };
}

/// The 1d bucket of day `day`, from every 1h row of that day (plan 3.5 step 6).
export const rollupDay = (feed: string, day: number, hours: readonly Bucket[], horizon: number): Bucket => bucketFromBuckets(feed, day, DAY, HOUR, hours, horizon);

/// 2h or 4h buckets at read time from 1h rows (plan 3.5): one bucket for every aligned window that holds a 1h row.
export function rollupWide(feed: string, width: 2 | 4, hours: readonly Bucket[], horizon: number): Bucket[] {
  const span = width * HOUR;
  const starts = [...new Set(hours.map((b) => align(b.t, span)))].sort((a, b) => a - b);
  return starts.map((s) => bucketFromBuckets(feed, s, span, HOUR, hours, horizon));
}

/// Plan 3.5: a bucket is drawn only when nothing in it is missing or a gap and at least one minute is open.
export const drawable = (b: Bucket): boolean => b.n_min_gap === 0 && b.n_min_open > 0;

/// The same rule at read time, for a reader that knows the horizon now. A stored row was computed at the horizon of
/// the tick that last wrote it; a bucket still forming then, and never touched again (the recorder stopped inside
/// it), keeps n_min_gap = 0 for minutes that have since elapsed without a row. Once the bucket has ended, every
/// missing or incomplete minute is a gap, so it is drawn only if n_min_retry is 0 as well. On a row recomputed after
/// the bucket ended this changes nothing (its retries are then a subset of its gaps).
export const drawableAt = (b: Bucket, width: number, horizon: number): boolean => drawable(b) && (b.t + width > horizon || b.n_min_retry === 0);
