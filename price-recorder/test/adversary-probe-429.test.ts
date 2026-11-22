// Adversary (unit d): CHARTS_DS_PLAN 4.1 "Rate-limit response: a 429 stops all further Data Streams calls in that
// tick and halves `P_bf` for 10 minutes", and 4.2 step 2 / backfill.ts STATE_SQL, which halves P_bf only when a `runs`
// row with n_429 > 0 is under 10 minutes old.
// The hourly restoration probe (tick.ts, plan 4.1) goes through the same limiter and client, so a 429 on it halts the
// tick, but its answer is never added to `allAnswers`, from which `runs.n_429` is counted. The tick's runs row then
// says n_429 = 0 and the next tick runs backfill at the full P_bf right after a 429.
// The 429 is a synthetic status with an empty body, as in tick-refusal.test.ts; every other answer is FakeStreams'
// (no capture data: the live and catch-up pages are real-shaped empty pages).
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { readTickState, repairWindow, unitBudget } from '../src/backfill';
import { FEEDS } from '../src/feeds';
import { HOUR } from '../src/rollup';
import { FakeStreams, msForLive, recordOnly, rows, tick, virtualClock } from './tick-helpers';

const M = 1792177200; // 2026-10-16 19:00:00 UTC, an hourly tick (the probe runs)
const BTC = FEEDS.find((f) => f.symbol === 'BTC')!.feedId.toLowerCase();

describe('adversary: a 429 on the hourly restoration probe (plan 4.1)', () => {
  it('is counted in runs.n_429, so the next tick halves P_bf (synthetic status)', async () => {
    expect(M % HOUR).toBe(0);
    await recordOnly(['BTC']); // the other 33 feeds are listed in config.feeds_refused: each gets one probe
    await env.DB.prepare('UPDATE config SET p_bf = 74 WHERE id = 1').run();
    const { last } = repairWindow(M + 60);
    await env.DB.batch([last, last - HOUR].map((h) => env.DB.prepare('INSERT INTO todo (feed, hour, tries) VALUES (?1, ?2, 0)').bind('BTC', h)));

    const clock = virtualClock(msForLive(M));
    // Only probes (calls for a feed other than BTC) get the 429; BTC's live and catch-up pages answer normally.
    const fake = new FakeStreams(clock, [], (call) => (call.feedId !== BTC ? { status: 429, body: '' } : null));
    const r = await tick(fake, clock);

    expect(r.outcome).toBe('recorded');
    expect(fake.calls.some((c) => c.feedId !== BTC)).toBe(true); // a probe was sent and answered 429
    const run = (await rows('SELECT n_429 FROM runs ORDER BY t DESC LIMIT 1'))[0];
    expect(r.run?.n_429).toBeGreaterThanOrEqual(1);
    expect(Number(run.n_429)).toBeGreaterThanOrEqual(1);

    // The next tick, a minute later: P_bf must be halved (74 -> 37: one unit, not two).
    const st = await readTickState(env.DB, [], M + 120, 74);
    expect(unitBudget(74, st.recent429)).toBe(1);
  });
});
