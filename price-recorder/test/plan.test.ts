// CHARTS_DS_PLAN 3.5 affected-bucket rule and 15.2 (g), (h), (i), (k): with pre-existing stored rows, a tick that
// repairs one minute recomputes exactly the buckets that minute lies in, from ALL their source rows, and leaves every
// other bucket alone; the incremental result equals a from-scratch rebuild over the same rows. Minutes are real
// (nyse-close-AAPL, metals-break-start-XAUUSD, nyse-open-AAPL); rows "moved" to another minute keep their real OHLC
// and say so (derived).
import { describe, expect, it } from 'vitest';

import { buildMinute, type MinuteRow } from '../src/candle';
import { toStored, type StoredMinute } from '../src/merge';
import { planTick, touchedDays, touchedHours } from '../src/plan';
import { HOUR, rollupDay, type Bucket } from '../src/rollup';
import { capture, feed, obsOf, withWord } from './helpers';

const AAPL = feed('AAPL');
const close = capture('nyse-close-AAPL');
const m1959 = buildMinute(AAPL, 1792094340, close); // open, hour 19
const m2000 = buildMinute(AAPL, 1792094400, close); // open, hour 20
const m2001 = buildMinute(AAPL, 1792094460, close); // closed
const m2002 = buildMinute(AAPL, 1792094520, close); // incomplete
const H19 = 1792090800;
const H20 = 1792094400;
const D15 = 1792022400;
const FAR = 2_000_000_000;
/// derived: a real row moved to minute t (OHLC and counters unchanged).
const moved = (r: MinuteRow, t: number): MinuteRow => ({ ...r, t, open_obs: r.open_obs === null ? null : t + (r.open_obs - r.t), close_obs: r.close_obs === null ? null : t + (r.close_obs - r.t) });
const asStored = (rows: MinuteRow[]): StoredMinute[] => rows.map((r) => toStored(r, 0));


/// Stored state after earlier ticks: every 1m row given, and the 1h rows a full rebuild over them gives.
function storeOf(rows: MinuteRow[], horizon: number) {
  const p = planTick(rows, [], [], horizon);
  return { minutes: p.minutes, hours: p.hours, quarters: p.quarters, days: p.days };
}

describe('touched sets come from the built rows, never from the clock', () => {
  it('a minute in the previous hour and day touches that hour and day only', () => {
    expect(touchedHours([m1959])).toEqual([{ feed: 'AAPL', start: H19 }]);
    expect(touchedDays([m1959])).toEqual([{ feed: 'AAPL', start: D15 }]);
    expect(touchedHours([m1959, m2000, m2001]).map((s) => s.start)).toEqual([H19, H20]);
  });
});

describe('(g) hour boundary: stored 19:00-19:58 and the 20:00 hour, a tick at 20:00:30 repairs 19:59', () => {
  // derived: the 19:59 minute's real OHLC moved to 19:00 .. 19:58.
  const earlier = Array.from({ length: 59 }, (_, i) => moved(m1959, H19 + 60 * i));
  const store = storeOf([...earlier, m2000, m2001], H20 + 30);
  const stored1m = store.minutes.filter((m) => m.t >= H19 && m.t < H20);
  const stored1h = store.hours;
  const p = planTick([m1959], stored1m, stored1h, H20 + 30);
  const scratch = planTick([...earlier, m1959, m2000, m2001], [], [], H20 + 30);

  it('before the repair the 19:45 quarter and the 19:00 hour carry exactly one missing minute', () => {
    expect(store.hours.find((h) => h.t === H19)).toMatchObject({ n_min_open: 59, n_min_gap: 1, n_min_retry: 1 });
    expect(store.quarters.find((q) => q.t === H19 + 2700)).toMatchObject({ n_min_open: 14, n_min_gap: 1, n_min_retry: 1 });
  });

  it('writes only the repaired minute, and the 19:00 hour and its quarters, and the day', () => {
    expect(p.minutes.map((m) => m.t)).toEqual([1792094340]);
    expect(p.hours.map((h) => h.t)).toEqual([H19]);
    expect(p.quarters.map((q) => q.t)).toEqual([H19, H19 + 900, H19 + 1800, H19 + 2700]);
    expect(p.days.map((d) => d.t)).toEqual([D15]);
  });

  it('the 19:45 quarter, the 19:00 hour and the day equal a from-scratch rebuild, with exact values', () => {
    expect(p.quarters).toEqual(scratch.quarters.filter((q) => q.t >= H19 && q.t < H20));
    expect(p.hours).toEqual(scratch.hours.filter((h) => h.t === H19));
    expect(p.days).toEqual(scratch.days);
    expect(p.hours[0]).toEqual({ feed: 'AAPL', t: H19, o: m1959.o, h: m1959.h, l: m1959.l, c: m1959.c, n_min_open: 60, n_min_closed: 0, n_min_gap: 0, n_min_retry: 0 });
    expect(p.days[0]).toMatchObject({ o: m1959.o, c: m2000.c, n_min_open: 61, n_min_closed: 1 });
  });

  it('the 20:00 rows are untouched (read for the day only)', () => {
    expect(p.hours.some((h) => h.t === H20)).toBe(false);
    expect(p.quarters.some((q) => q.t >= H20)).toBe(false);
  });

  it('(i) the plain live minute: a tick that builds 19:58 alone gives the same buckets as the rebuild', () => {
    const without = earlier.filter((r) => r.t !== H19 + 58 * 60);
    const s = storeOf([...without, m1959, m2000, m2001], H20 + 30);
    const q = planTick([earlier[58]], s.minutes.filter((m) => m.t < H20), s.hours, H20 + 30);
    expect(q.hours).toEqual(scratch.hours.filter((h) => h.t === H19));
    expect(q.days).toEqual(scratch.days);
  });
});

describe('(h) UTC midnight: hours 00:00-22:00 stored, a tick at 00:00:30 repairs 23:59 of the day before', () => {
  const D14 = D15 - 86400;
  const H23 = D15 - HOUR;
  // derived: real OHLC of 19:59 moved across the 14th; 23:59 is the repair.
  const day = Array.from({ length: 23 * 60 }, (_, i) => moved(m1959, D14 + 60 * i));
  const last = Array.from({ length: 59 }, (_, i) => moved(m2000, H23 + 60 * i));
  const repair = moved(m1959, H23 + 59 * 60);
  const next = moved(m2000, D15);
  const store = storeOf([...day, ...last, next], D15 + 30);
  const p = planTick([repair], store.minutes.filter((m) => m.t >= H23 && m.t < D15), store.hours.filter((h) => h.t < D15), D15 + 30);
  const scratch = planTick([...day, ...last, repair, next], [], [], D15 + 30);

  it('the 23:00 hour and the 14th recompute exactly; the 15th is not written', () => {
    expect(p.hours.map((h) => h.t)).toEqual([H23]);
    expect(p.days.map((d) => d.t)).toEqual([D14]);
    expect(p.hours).toEqual(scratch.hours.filter((h) => h.t === H23));
    expect(p.days).toEqual(scratch.days.filter((d) => d.t === D14));
    expect(p.days[0]).toMatchObject({ o: m1959.o, c: m1959.c, n_min_open: 1440, n_min_gap: 0, n_min_retry: 0 });
  });

  it('reading a 1h row of another day is refused (the read set is the touched days only)', () => {
    expect(() => planTick([repair], [], store.hours, D15 + 30)).toThrow(/outside the touched days/);
  });
});

describe('(k) a backfill unit for an hour with some live-recorded minutes', () => {
  const open = capture('nyse-open-AAPL');
  const rows = [1792070940, 1792071000, 1792071060, 1792071120].map((t) => buildMinute(AAPL, t, open));
  const H13 = 1792069200;

  it('reads them and yields the same rollups as one full rebuild', () => {
    const live = storeOf(rows.slice(0, 2), FAR);
    const unit = planTick(rows.slice(2), live.minutes, live.hours, FAR);
    const full = planTick(rows, [], [], FAR);
    expect(unit.hours).toEqual(full.hours);
    expect(unit.quarters).toEqual(full.quarters);
    expect(unit.days).toEqual(full.days);
    expect(unit.hours[0]).toMatchObject({ t: H13, n_min_open: 2, n_min_closed: 1, n_min_gap: 57, n_min_retry: 57 });
  });

  it('a backfill re-fetch that comes back incomplete never overwrites the stored open rows (sweep A)', () => {
    const live = storeOf(rows.slice(0, 3), FAR);
    const retry = [1792071000, 1792071060].map((t) => buildMinute(AAPL, t, []));
    expect(retry.every((r) => r.state === 'incomplete')).toBe(true);
    const p = planTick(retry, live.minutes, live.hours, FAR);
    expect(p.minutes).toEqual([]);
    expect(p.hours).toEqual(live.hours);
  });
});

describe('a conflict makes every bucket holding the minute a gap, with exact counters (15.2 j)', () => {
  it('stored open hour; a same-second re-fetch of 20:00 -> 20:00 quarter, hour and day become gaps', () => {
    const store = storeOf([m1959, m2000, m2001, m2002], FAR);
    const twin = withWord(close.find((e) => obsOf(e) === 1792094400 + 3)!, 7, 1n); // derived: midPrice word changed
    const conflict = buildMinute(AAPL, 1792094400, [...close, twin]);
    expect(conflict.state).toBe('conflict');
    const p = planTick([conflict], store.minutes.filter((m) => m.t >= H20), store.hours, FAR);
    expect(p.merges[0]).toMatchObject({ event: 'conflict', becameConflict: true });
    expect(p.quarters[0]).toMatchObject({ t: H20, o: null, n_min_open: 0, n_min_closed: 1, n_min_gap: 14, n_min_retry: 13 });
    expect(p.hours[0]).toMatchObject({ t: H20, o: null, n_min_open: 0, n_min_closed: 1, n_min_gap: 59, n_min_retry: 58 });
    const d = rollupDay('AAPL', D15, [...store.hours.filter((h) => h.t !== H20), p.hours[0]], FAR);
    expect(p.days[0]).toEqual(d);
    expect(p.days[0].o).toBe(m1959.o);
    expect(p.evidence).toHaveLength(1);
  });
});

describe('runs.rejected from a plan never re-counts a retried minute', () => {
  it('the same incomplete minute with a rejected entry, three ticks running, counts once', () => {
    const bad = close.map((e) => (obsOf(e) === 1792094520 + 5 ? { ...e, fullReport: 'not hex' } : e)); // derived
    const inc = buildMinute(AAPL, 1792094520, bad);
    expect(inc).toMatchObject({ state: 'incomplete', n_rejected: 1 });
    let stored: StoredMinute[] = [];
    let hours: Bucket[] = [];
    const totals: number[] = [];
    for (let i = 0; i < 3; i++) {
      const p = planTick([inc], stored, hours, FAR);
      totals.push(p.rejected);
      stored = p.minutes.length ? p.minutes : stored;
      hours = p.hours;
    }
    expect(totals).toEqual([1, 0, 0]);
    expect(stored[0]).toMatchObject({ tries: 3, n_rejected: 1 });
  });
});

describe('guards', () => {
  it('two built rows for one minute (live and backfill overlapping) throw', () => {
    expect(() => planTick([m2000, m2000], [], [], FAR)).toThrow(/two built rows/);
  });
  it('a stored 1m row outside the touched hours is refused', () => {
    expect(() => planTick([m2000], asStored([m1959]), [], FAR)).toThrow(/outside the touched hours/);
  });
  it('two stored rows for one minute are refused', () => {
    expect(() => planTick([m2001], asStored([m2000, m2000]), [], FAR)).toThrow(/two stored rows/);
  });
  it('a tick with no rows writes nothing', () => {
    expect(planTick([], [], [], FAR)).toMatchObject({ minutes: [], quarters: [], hours: [], days: [], evidence: [], rejected: 0 });
  });
  it('merges keep the order of the built rows', () => {
    expect(planTick([m2001, m1959], [], [], FAR).merges.map((m) => m.t)).toEqual([m2001.t, m1959.t]);
  });
});
