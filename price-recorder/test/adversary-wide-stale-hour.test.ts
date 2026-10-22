// Adversary (unit e, 3db4ef0): a 2h candle drawn over minutes the 1h answer itself serves as a gap.
//
// The stored state is the one rollup.ts drawableAt's own comment names: a 1h row last written while its hour was still
// forming (the recorder stopped inside it) and never touched again keeps n_min_gap = 0 for minutes that have since
// elapsed without a row, with those minutes in n_min_retry. Both rows below are written through the production write
// path (planTick + candleWrites), each at the horizon of the tick that wrote it.
//
// /v1/candles?tf=1h correctly serves that ended hour as a gap (drawableAt: ended and n_min_retry > 0). /v1/candles?tf=2h
// builds the 2h bucket from the same 1h rows (rollupWide sums the sub-rows' n_min_gap = 0), the 2h bucket has not ended
// at asOf, so drawableAt passes and the bucket is served as a CANDLE although 29 elapsed minutes inside it have no row.
// Plan 3.5: "A bucket is drawable iff n_min_gap = 0 ... (missing rows ... among those already elapsed)"; 2h and 4h
// "built from 1h rows at read time by the same rule"; section 10: missing data is sent as gaps.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { buildMinute } from '../src/candle';
import { candleWrites, readHoursOfDays, readMinutesOfHours } from '../src/db';
import { planTick, touchedDays, touchedHours } from '../src/plan';
import { handleRead } from '../src/read';
import { HOUR } from '../src/rollup';
import { derivedSeconds, feed } from './helpers';

const TOKEN = 'test-read-token-not-a-credential';
const db = () => env.DB;
const H = 1792173600; // 2026-10-16 18:00:00 UTC, 2h-aligned (1792173600 % 7200 = 0)

const get = async (path: string) => {
  const r = await handleRead(new Request(`https://recorder.test${path}`, { headers: { authorization: `Bearer ${TOKEN}` } }), { DB: db(), RECORDER_READ_TOKEN: TOKEN });
  return (await r.json()) as { candles: { t: number }[]; gaps: number[]; asOf: number };
};
const openMinute = (t: number) => buildMinute(feed('BTC'), t, derivedSeconds(feed('BTC'), t, t + 61), true);
async function store(built: ReturnType<typeof openMinute>[], horizon: number) {
  const [m, h] = await Promise.all([readMinutesOfHours(db(), touchedHours(built)), readHoursOfDays(db(), touchedDays(built))]);
  await db().batch(candleWrites(db(), planTick(built, m, h, horizon)));
}

describe('adversary: 2h from a stale 1h row', () => {
  it('an ended hour that /v1/candles?tf=1h serves as a gap is not drawn as a candle by tf=2h', async () => {
    expect(H % (2 * HOUR)).toBe(0);
    await db().prepare('UPDATE config SET serve = 1 WHERE id = 1').run();
    // Hour H: minutes 00..30 recorded, written at horizon H+31m; the recorder then stops inside the hour.
    await store(Array.from({ length: 31 }, (_, i) => openMinute(H + i * 60)), H + 31 * 60);
    // Hour H+1h: minutes 00..30 recorded (the newest at H+1h30m), written at horizon H+1h31m. Hour H is not touched.
    await store(Array.from({ length: 31 }, (_, i) => openMinute(H + HOUR + i * 60)), H + HOUR + 31 * 60);

    const h1 = await get('/v1/candles?s=BTC&tf=1h');
    expect(h1.asOf).toBe(H + HOUR + 31 * 60);
    expect(h1.gaps).toContain(H); // the 1h answer: hour H ended with 29 minutes missing -> gap

    const h2 = await get('/v1/candles?s=BTC&tf=2h');
    // [H, H+2h) holds minutes H+31m..H+59m, elapsed at asOf with no row: missing data, so a gap, never a candle.
    expect(h2.candles.map((c) => c.t), '2h candle drawn over 29 elapsed missing minutes').not.toContain(H);
    expect(h2.gaps).toContain(H);
  }, 60_000);
});
