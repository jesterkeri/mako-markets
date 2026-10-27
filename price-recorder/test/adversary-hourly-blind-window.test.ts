// Adversary (unit f): plan 12 says "crypto: alert on any" empty minute and "alert if a feed has > 5 incomplete minutes
// in an hour". Each hourly tick at H reads [H - 3600, H - 600); the next reads [H, H + 3000). The ten minutes
// [H - 600, H) are read by neither, so every hour has a 10-minute window in which no threshold is ever checked.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { dbReasons } from '../src/monitor';

const db = () => env.DB;
const H = 1792177200; // an hourly tick (multiple of 3600)

const ins = (feed: string, t: number, state: string) =>
  db()
    .prepare(
      "INSERT INTO candles_1m (feed, t, state, o, h, l, c, n_reports, n_open, n_rejected, n_valid, n_raw, raw_rule, rules_version, tries) VALUES (?1, ?2, ?3, ?4, ?4, ?4, ?4, 0, 0, 0, 0, 0, 1, 'v', 0)",
    )
    .bind(feed, t, state, state === 'open' ? '1' : null);

describe('every minute of every hour is read by some hourly check', () => {
  it('a crypto empty minute at H - 5 min alerts on the hourly tick at H or at H + 1 h', async () => {
    await ins('BTC', H - 300, 'empty').run();
    const atH = await dbReasons(db(), H);
    const atNext = await dbReasons(db(), H + 3600);
    expect([...atH, ...atNext]).toContain('empty:BTC');
  });

  it('nine incomplete minutes in [H - 9 min, H) alert on one of the two hourly ticks', async () => {
    await db().batch(Array.from({ length: 9 }, (_, i) => ins('ETH', H - 540 + i * 60, 'incomplete')));
    const atH = await dbReasons(db(), H);
    const atNext = await dbReasons(db(), H + 3600);
    expect([...atH, ...atNext]).toContain('incomplete:ETH');
  });
});
