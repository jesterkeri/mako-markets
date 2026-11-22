// Adversary on eda38c7 (unit b): rollup arithmetic against an independent, naive reading of CHARTS_DS_PLAN 3.5,
// through D1 (store, read back), over seeded random ticks. Minutes are derived from one real row (nyse-close-AAPL
// 19:59, open) moved to other minutes with their state and OHLC replaced: derived, said so. Prices span 1 to 10^40
// (18-decimal integers, beyond 2^64) so a number or text comparison anywhere would show. Every minute is written
// exactly once, in random order across ticks, so the final stored rollups must equal the naive recompute.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { buildMinute, type MinuteRow, type MinuteState } from '../src/candle';
import { candleWrites, parseBucket, readHoursOfDays, readMinutesOfHours } from '../src/db';
import { planTick, touchedDays, touchedHours } from '../src/plan';
import { capture, feed } from './helpers';

const base = buildMinute(feed('AAPL'), 1792094340, capture('nyse-close-AAPL'));
const db = () => env.DB;
const D0 = 1792022400; // a UTC day start
const FAR = 2_000_000_000;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}
const big = (r: () => number): bigint => {
  const digits = 1 + Math.floor(r() * 40);
  let x = BigInt(1 + Math.floor(r() * 9));
  for (let i = 1; i < digits; i++) x = x * 10n + BigInt(Math.floor(r() * 10));
  return x;
};
const STATES: MinuteState[] = ['open', 'open', 'open', 'closed', 'unknown', 'stale', 'empty', 'incomplete', 'conflict'];

function derived(t: number, state: MinuteState, r: () => number): MinuteRow {
  if (state !== 'open')
    return { ...base, t, state, o: null, h: null, l: null, c: null, open_obs: null, close_obs: null, conflicts: state === 'conflict' ? [{ obs: t, keccakA: '0x01', keccakB: '0x02' }] : [] };
  const ps = [big(r), big(r), big(r), big(r)];
  const hi = ps.reduce((a, b) => (b > a ? b : a));
  const lo = ps.reduce((a, b) => (b < a ? b : a));
  return { ...base, t, state, o: ps[0].toString(), h: hi.toString(), l: lo.toString(), c: ps[3].toString(), open_obs: t, close_obs: t + 59 };
}

type Naive = { o: string | null; h: string | null; l: string | null; c: string | null; n_min_open: number; n_min_closed: number; n_min_gap: number; n_min_retry: number };
function naive(cells: Map<number, MinuteRow>, start: number, span: number, horizon: number): Naive {
  let open = 0;
  let closed = 0;
  let gap = 0;
  let retry = 0;
  let o: string | null = null;
  let c: string | null = null;
  let h: bigint | null = null;
  let l: bigint | null = null;
  for (let t = start; t < start + span; t += 60) {
    const m = cells.get(t);
    if (!m) {
      retry++;
      if (t + 60 <= horizon) gap++;
      continue;
    }
    if (m.state === 'open') {
      open++;
      if (o === null) o = m.o;
      c = m.c;
      if (h === null || BigInt(m.h!) > h) h = BigInt(m.h!);
      if (l === null || BigInt(m.l!) < l) l = BigInt(m.l!);
    } else if (m.state === 'closed') closed++;
    else {
      gap++;
      if (m.state === 'incomplete') retry++;
    }
  }
  return { o, h: h === null ? null : h.toString(), l: l === null ? null : l.toString(), c, n_min_open: open, n_min_closed: closed, n_min_gap: gap, n_min_retry: retry };
}

describe('rollups equal a naive recompute after random ticks through D1', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    it(`seed ${seed}`, async () => {
      const r = rng(seed);
      const truth = new Map<number, MinuteRow>();
      const minutes: number[] = [];
      for (let t = D0 - 7200; t < D0 + 3 * 3600; t += 60) if (r() < 0.8) minutes.push(t);
      for (let i = minutes.length - 1; i > 0; i--) {
        const j = Math.floor(r() * (i + 1));
        [minutes[i], minutes[j]] = [minutes[j], minutes[i]];
      }
      while (minutes.length) {
        const batch = minutes.splice(0, 1 + Math.floor(r() * 40)).map((t) => derived(t, STATES[Math.floor(r() * STATES.length)], r));
        for (const m of batch) truth.set(m.t, m);
        const [sm, sh] = await Promise.all([readMinutesOfHours(db(), touchedHours(batch)), readHoursOfDays(db(), touchedDays(batch))]);
        await db().batch(candleWrites(db(), planTick(batch, sm, sh, FAR)));
      }
      const all = async (tbl: string) => (await db().prepare(`SELECT * FROM ${tbl}`).all<Record<string, unknown>>()).results.map(parseBucket);
      const strip = (b: ReturnType<typeof parseBucket>) => ({ o: b.o, h: b.h, l: b.l, c: b.c, n_min_open: b.n_min_open, n_min_closed: b.n_min_closed, n_min_gap: b.n_min_gap, n_min_retry: b.n_min_retry });
      for (const b of await all('candles_15m')) expect(strip(b), `15m ${b.t}`).toEqual(naive(truth, b.t, 900, FAR));
      for (const b of await all('candles_1h')) expect(strip(b), `1h ${b.t}`).toEqual(naive(truth, b.t, 3600, FAR));
      for (const b of await all('candles_1d')) expect(strip(b), `1d ${b.t}`).toEqual(naive(truth, b.t, 86400, FAR));
      expect((await all('candles_1d')).length).toBe(2);
    });
  }
});
