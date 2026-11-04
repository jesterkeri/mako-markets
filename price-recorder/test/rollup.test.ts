// CHARTS_DS_PLAN 3.5 rollup rules, pure, at the edges: bucket boundaries, the elapsed horizon, empty, closed and gap
// minutes (section 10: closed never breaks a bucket, missing data always does), exact bigint OHLC, 1d from 1h, and 2h
// and 4h at read time. Minute rows here are rollup inputs, not report bytes; prices are taken from the real captures
// (open-minute-AAPL, nyse-close-AAPL) so the values are real 18-decimal integers.
import { describe, expect, it } from 'vitest';

import { buildMinute } from '../src/candle';
import { align, bucketFromBuckets, bucketFromMinutes, drawable, drawableAt, elapsedMinutes, rollupDay, rollupHour, rollupWide, type Bucket, type MinuteCell } from '../src/rollup';
import { capture, feed } from './helpers';

const H = 1792094400; // 2026-10-15 20:00 UTC (the NYSE close hour)
const D = 1792022400; // 2026-10-15 00:00 UTC
const real = buildMinute(feed('AAPL'), 1792076400, capture('open-minute-AAPL'));
const P = { o: real.o!, h: real.h!, l: real.l!, c: real.c! };
const openAt = (t: number, p: Partial<typeof P> = {}): MinuteCell => ({ t, state: 'open', ...P, ...p });
const at = (t: number, state: Exclude<MinuteCell['state'], 'open'>): MinuteCell => ({ t, state, o: null, h: null, l: null, c: null });
const FAR = 2_000_000_000;

describe('one bucket from 1m rows', () => {
  it('a full hour of open minutes: drawable, 60 open, nothing to retry', () => {
    const rows = Array.from({ length: 60 }, (_, i) => openAt(H + 60 * i));
    const b = bucketFromMinutes('AAPL', H, 3600, rows, FAR);
    expect(b).toEqual({ feed: 'AAPL', t: H, ...P, n_min_open: 60, n_min_closed: 0, n_min_gap: 0, n_min_retry: 0 });
    expect(drawable(b)).toBe(true);
  });

  it('open is the first open minute, close the last, high the max and low the min, compared as bigint not text', () => {
    const rows = [at(H, 'closed'), openAt(H + 60, { o: '9', h: '9', l: '9', c: '9' }), openAt(H + 120, { o: '10', h: '100', l: '8', c: '11' }), openAt(H + 180, { o: '12', h: '12', l: '12', c: '12' }), at(H + 240, 'closed')];
    expect(bucketFromMinutes('AAPL', H, 900, rows, FAR)).toMatchObject({ o: '9', h: '100', l: '8', c: '12', n_min_open: 3, n_min_closed: 2 });
  });

  it('rows outside the bucket are ignored: [start, start + span) edges', () => {
    const rows = [openAt(H - 60, { h: '999999999999999999999999' }), openAt(H), openAt(H + 840), openAt(H + 900, { l: '1' })];
    const b = bucketFromMinutes('AAPL', H, 900, rows, FAR);
    expect(b).toMatchObject({ n_min_open: 2, h: P.h, l: P.l });
  });

  it('closed minutes never break a bucket (market hours, section 10)', () => {
    const rows = [...Array.from({ length: 30 }, (_, i) => at(H + 60 * i, 'closed')), ...Array.from({ length: 30 }, (_, i) => openAt(H + 1800 + 60 * i))];
    const b = bucketFromMinutes('AAPL', H, 3600, rows, FAR);
    expect(b).toMatchObject({ n_min_open: 30, n_min_closed: 30, n_min_gap: 0, n_min_retry: 0 });
    expect(drawable(b)).toBe(true);
  });

  it('a fully closed bucket has no price and is not drawn (collapsed, not a gap)', () => {
    const b = bucketFromMinutes('AAPL', H, 900, Array.from({ length: 15 }, (_, i) => at(H + 60 * i, 'closed')), FAR);
    expect(b).toEqual({ feed: 'AAPL', t: H, o: null, h: null, l: null, c: null, n_min_open: 0, n_min_closed: 15, n_min_gap: 0, n_min_retry: 0 });
    expect(drawable(b)).toBe(false);
  });

  it.each(['unknown', 'stale', 'empty', 'conflict'] as const)('one %s minute makes the bucket a gap, without a retry', (s) => {
    const rows = [...Array.from({ length: 14 }, (_, i) => openAt(H + 60 * i)), at(H + 840, s)];
    const b = bucketFromMinutes('AAPL', H, 900, rows, FAR);
    expect(b).toMatchObject({ n_min_open: 14, n_min_gap: 1, n_min_retry: 0 });
    expect(drawable(b)).toBe(false);
  });

  it('one incomplete minute is a gap and a retry', () => {
    const rows = [...Array.from({ length: 14 }, (_, i) => openAt(H + 60 * i)), at(H + 840, 'incomplete')];
    expect(bucketFromMinutes('AAPL', H, 900, rows, FAR)).toMatchObject({ n_min_gap: 1, n_min_retry: 1 });
  });

  it('one missing elapsed minute is a gap and a retry; the price of the others is still computed', () => {
    const rows = Array.from({ length: 14 }, (_, i) => openAt(H + 60 * i));
    const b = bucketFromMinutes('AAPL', H, 900, rows, FAR);
    expect(b).toMatchObject({ ...P, n_min_open: 14, n_min_gap: 1, n_min_retry: 1 });
    expect(drawable(b)).toBe(false);
  });

  it('a forming bucket: minutes not yet elapsed are retried but are not gaps, so it draws', () => {
    const rows = Array.from({ length: 5 }, (_, i) => openAt(H + 60 * i));
    // horizon H + 300: minutes H .. H+240 have elapsed (M + 60 <= horizon), all have rows.
    const b = bucketFromMinutes('AAPL', H, 900, rows, H + 300);
    expect(b).toMatchObject({ n_min_open: 5, n_min_gap: 0, n_min_retry: 10 });
    expect(drawable(b)).toBe(true);
  });

  it('the horizon edge: a minute M is elapsed iff M + 60 <= horizon', () => {
    const rows = Array.from({ length: 5 }, (_, i) => openAt(H + 60 * i));
    expect(bucketFromMinutes('AAPL', H, 900, rows, H + 359).n_min_gap).toBe(0);
    expect(bucketFromMinutes('AAPL', H, 900, rows, H + 360).n_min_gap).toBe(1);
    expect(elapsedMinutes(H, 3600, H + 59)).toBe(0);
    expect(elapsedMinutes(H, 3600, H + 60)).toBe(1);
    expect(elapsedMinutes(H, 3600, H + 9000)).toBe(60);
    expect(elapsedMinutes(H, 3600, H - 10)).toBe(0);
  });

  it('an empty hour, entirely in the past: 60 gaps, 60 retries, no price', () => {
    expect(bucketFromMinutes('AAPL', H, 3600, [], FAR)).toEqual({ feed: 'AAPL', t: H, o: null, h: null, l: null, c: null, n_min_open: 0, n_min_closed: 0, n_min_gap: 60, n_min_retry: 60 });
  });

  it('rejects two rows for one minute, a misaligned row and a misaligned bucket', () => {
    expect(() => bucketFromMinutes('AAPL', H, 900, [openAt(H), openAt(H)], FAR)).toThrow();
    expect(() => bucketFromMinutes('AAPL', H, 900, [openAt(H + 1)], FAR)).toThrow();
    expect(() => bucketFromMinutes('AAPL', H + 1, 900, [], FAR)).toThrow();
    expect(() => bucketFromMinutes('AAPL', H, 900, [{ ...openAt(H), o: null }], FAR)).toThrow();
  });
});

describe('drawableAt: a stored row of a bucket that was still forming when last written', () => {
  // Written at H + 300 with five open minutes; the recorder then stopped inside the hour.
  const rows = Array.from({ length: 5 }, (_, i) => openAt(H + 60 * i));
  const stale = bucketFromMinutes('AAPL', H, 3600, rows, H + 300);

  it('draws while the bucket is still forming', () => {
    expect(drawable(stale)).toBe(true);
    expect(drawableAt(stale, 3600, H + 300)).toBe(true);
    expect(drawableAt(stale, 3600, H + 3599)).toBe(true);
  });

  it('is a gap once the bucket has ended with minutes still missing', () => {
    expect(drawableAt(stale, 3600, H + 3600)).toBe(false);
  });

  it('a complete ended bucket still draws, and a gap never draws', () => {
    const full = bucketFromMinutes('AAPL', H, 3600, Array.from({ length: 60 }, (_, i) => openAt(H + 60 * i)), FAR);
    expect(drawableAt(full, 3600, FAR)).toBe(true);
    expect(drawableAt({ ...full, n_min_gap: 1 }, 3600, H + 100)).toBe(false);
    expect(drawableAt({ ...full, o: null, h: null, l: null, c: null, n_min_open: 0, n_min_closed: 60 }, 3600, FAR)).toBe(false);
  });
});

describe('the four quarters and the hour', () => {
  it('quarters are [H, H+900), [H+900, H+1800), ... and sum to the hour', () => {
    const rows = [openAt(H + 840, { o: '1', h: '1', l: '1', c: '1' }), openAt(H + 900, { o: '2', h: '2', l: '2', c: '2' }), at(H + 2700, 'closed'), openAt(H + 3540, { o: '3', h: '3', l: '3', c: '3' })];
    const { q, h } = rollupHour('AAPL', H, rows, FAR);
    expect(q.map((b) => b.t)).toEqual([H, H + 900, H + 1800, H + 2700]);
    expect(q.map((b) => [b.o, b.c, b.n_min_open, b.n_min_closed])).toEqual([['1', '1', 1, 0], ['2', '2', 1, 0], [null, null, 0, 0], ['3', '3', 1, 1]]);
    expect(h).toMatchObject({ o: '1', h: '3', l: '1', c: '3', n_min_open: 3, n_min_closed: 1, n_min_gap: 56, n_min_retry: 56 });
    for (const k of ['n_min_open', 'n_min_closed', 'n_min_gap', 'n_min_retry'] as const) expect(q.reduce((s, b) => s + b[k], 0)).toBe(h[k]);
  });
});

describe('1d from 1h, and 2h / 4h at read time', () => {
  const hourRow = (t: number, p: Partial<Bucket> = {}): Bucket => ({ feed: 'AAPL', t, ...P, n_min_open: 60, n_min_closed: 0, n_min_gap: 0, n_min_retry: 0, ...p });
  const closedHour = (t: number): Bucket => ({ feed: 'AAPL', t, o: null, h: null, l: null, c: null, n_min_open: 0, n_min_closed: 60, n_min_gap: 0, n_min_retry: 0 });

  it('a stock day: closed hours and open hours, every hour present -> drawable, OHLC from open hours only', () => {
    const hours = Array.from({ length: 24 }, (_, i) => (i >= 13 && i < 20 ? hourRow(D + 3600 * i, { o: String(100 + i), h: String(200 + i), l: String(50 + i), c: String(150 + i) }) : closedHour(D + 3600 * i)));
    const d = rollupDay('AAPL', D, hours, FAR);
    expect(d).toEqual({ feed: 'AAPL', t: D, o: '113', h: '219', l: '63', c: '169', n_min_open: 420, n_min_closed: 1020, n_min_gap: 0, n_min_retry: 0 });
    expect(drawable(d)).toBe(true);
  });

  it('a missing elapsed hour makes the day a gap; a missing future hour does not', () => {
    const hours = Array.from({ length: 12 }, (_, i) => hourRow(D + 3600 * i));
    const forming = rollupDay('AAPL', D, hours, D + 12 * 3600);
    expect(forming).toMatchObject({ n_min_open: 720, n_min_gap: 0, n_min_retry: 720 });
    expect(drawable(forming)).toBe(true);
    const later = rollupDay('AAPL', D, hours, D + 12 * 3600 + 90);
    expect(later).toMatchObject({ n_min_gap: 1, n_min_retry: 720 });
    expect(drawable(later)).toBe(false);
  });

  it('an hour row with a gap makes the day a gap', () => {
    const hours = Array.from({ length: 24 }, (_, i) => hourRow(D + 3600 * i, i === 5 ? { n_min_open: 59, n_min_gap: 1, n_min_retry: 1 } : {}));
    expect(drawable(rollupDay('AAPL', D, hours, FAR))).toBe(false);
  });

  it('2h and 4h windows are UTC-aligned and use only the 1h rows inside them', () => {
    const hours = [hourRow(D + 3600, { o: '1', h: '1', l: '1', c: '1' }), hourRow(D + 2 * 3600, { o: '2', h: '2', l: '2', c: '2' }), hourRow(D + 5 * 3600, { o: '5', h: '5', l: '5', c: '5' })];
    expect(rollupWide('AAPL', 2, hours, FAR).map((b) => [b.t - D, b.o, b.c, b.n_min_open, b.n_min_gap])).toEqual([[0, '1', '1', 60, 60], [7200, '2', '2', 60, 60], [14400, '5', '5', 60, 60]]);
    expect(rollupWide('AAPL', 4, hours, FAR).map((b) => [b.t - D, b.o, b.h, b.c, b.n_min_open, b.n_min_gap])).toEqual([[0, '1', '2', '2', 120, 120], [14400, '5', '5', '5', 60, 180]]);
  });

  it('sub-buckets given out of time order still give open from the first hour and close from the last', () => {
    const hours = [hourRow(D + 5 * 3600, { o: '5', h: '5', l: '5', c: '5' }), hourRow(D + 3600, { o: '1', h: '1', l: '1', c: '1' }), hourRow(D + 2 * 3600, { o: '2', h: '2', l: '2', c: '2' })];
    expect(rollupDay('AAPL', D, hours, FAR)).toMatchObject({ o: '1', h: '5', l: '1', c: '5' });
    expect(rollupWide('AAPL', 4, hours, FAR)[0]).toMatchObject({ o: '1', c: '2' });
  });

  it('rejects a sub-bucket that is not aligned and two rows for one hour', () => {
    expect(() => bucketFromBuckets('AAPL', D, 86400, 3600, [hourRow(D + 60)], FAR)).toThrow();
    expect(() => bucketFromBuckets('AAPL', D, 86400, 3600, [hourRow(D), hourRow(D)], FAR)).toThrow();
    expect(() => bucketFromBuckets('AAPL', D + 3600, 86400, 3600, [], FAR)).toThrow();
  });

  it('align floors to the bucket width', () => {
    expect(align(D + 86399, 86400)).toBe(D);
    expect(align(D, 3600)).toBe(D);
    expect(align(H + 899, 900)).toBe(H);
    expect(align(H + 900, 900)).toBe(H + 900);
  });
});
