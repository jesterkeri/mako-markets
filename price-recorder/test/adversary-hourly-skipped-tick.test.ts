// Adversary (unit f, after 73ea3e8): plan 12 says "crypto: alert on any" empty minute, and every minute must be read
// by some hourly check. Only the run whose live minute M is a multiple of 3600 reads the window [M - 4200, M - 600).
// When that run sends no assessment (lease_busy: the previous tick still holds the lease) or no run ever gets
// M = H (one cron firing 30 s late), no later run reads that window: the next hourly run reads [H - 600, H + 3000).
// Healthchecks sees one missing ping inside its 5-minute grace, so nothing alerts.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { monitorRun } from '../src/monitor';
import type { TickReport } from '../src/tick';

const db = () => env.DB;
const H = 1792177200; // an hourly live minute (multiple of 3600)

const ins = (feed: string, t: number, state: string) =>
  db()
    .prepare(
      "INSERT INTO candles_1m (feed, t, state, o, h, l, c, n_reports, n_open, n_rejected, n_valid, n_raw, raw_rule, rules_version, tries) VALUES (?1, ?2, ?3, ?4, ?4, ?4, ?4, 0, 0, 0, 0, 0, 1, 'v', 0)",
    )
    .bind(feed, t, state, state === 'open' ? '1' : null);

const report = (over: Partial<TickReport>): TickReport => ({
  outcome: 'recorded',
  recovered: false,
  minute: null,
  run: { calls: 34, n_429: 0, rejected: 0, incomplete: 0, conflicts: 0, lag_s: 40, unauthorized: [], key_failure: 0 },
  batchStatements: 12,
  samples: [],
  ...over,
});

const deps = () => ({ db: db(), fetchImpl: (async () => new Response('')) as typeof fetch, pingUrl: undefined, rpcUrl: 'https://rpc.test', log: () => {} });

describe('a skipped hourly run leaves its hour unchecked', () => {
  it('control: the same minute alerts when the run at H does run', async () => {
    await ins('BTC', H - 1800, 'empty').run();
    expect((await monitorRun(deps(), report({ minute: H }), [])).reasons).toContain('empty:BTC');
  });

  it('a crypto empty minute at H - 30 min alerts on some run when the run at H is lease_busy', async () => {
    await ins('BTC', H - 1800, 'empty').run();
    const seen: string[] = [];
    // The hourly run at H could not take the lease: no minute, no ping, no D1 read.
    seen.push(...(await monitorRun(deps(), report({ outcome: 'lease_busy', minute: null, run: null }), [])).reasons);
    // Every following minute's run, through the next hourly run at H + 1 h.
    for (let m = H + 60; m <= H + 3600; m += 60) seen.push(...(await monitorRun(deps(), report({ minute: m }), [])).reasons);
    expect(seen).toContain('empty:BTC');
  });

});
