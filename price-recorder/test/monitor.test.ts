// Monitoring (CHARTS_DS_PLAN 12; unit f): every alert condition at its threshold, the hourly on-chain sample (match,
// drift, revert, an unreachable RPC), the one Healthchecks ping per run (base on healthy, /fail with codes, none when
// the tick could not run, never a secret), and a whole scheduled run on local D1.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, type Hex } from 'viem';

import { reportBlob } from '../src/envelope';
import { scheduledRun } from '../src/index';
import { dbReasons, hourReasons, monitorRun, ping, tickReasons, verifySample, type HourRow } from '../src/monitor';
import type { TickReport } from '../src/tick';
import { capture } from './helpers';
import { BASE, CREDS, d1Now, FakeStreams, msForLive, recordOnly, tick, virtualClock } from './tick-helpers';

const db = () => env.DB;
const HC = 'https://hc-ping.test/uuid-not-a-credential';
const RPC = 'https://rpc.test';

const report = (over: Partial<TickReport> = {}): TickReport => ({
  outcome: 'recorded',
  recovered: false,
  minute: 1792177740,
  run: { calls: 34, n_429: 0, rejected: 0, incomplete: 0, conflicts: 0, lag_s: 40, unauthorized: [], key_failure: 0 },
  batchStatements: 12,
  samples: [],
  ...over,
});

/// A fetch that records every call and answers by URL.
function recorder(answer: (url: string, body: string) => Response | Promise<Response>) {
  const calls: { url: string; body: string }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === 'string' ? init.body : '';
    calls.push({ url, body });
    return answer(url, body);
  }) as typeof fetch;
  return { f, calls };
}

describe('conditions from the tick (pure)', () => {
  it('a healthy recorded tick has no reason; a tick that could not run sends no ping', () => {
    expect(tickReasons(report(), [])).toEqual({ ping: true, reasons: [] });
    expect(tickReasons(report({ outcome: 'lease_busy', run: null }), [])).toEqual({ ping: false, reasons: [] });
  });

  it('each failed outcome, key failure, refusals, conflicts and logged events become reason codes', () => {
    for (const o of ['tick_failed', 'batch_failed', 'lease_lost', 'deadline', 'config_invalid', 'no_credentials'] as const) {
      expect(tickReasons(report({ outcome: o, run: null }), []).reasons, o).toEqual([o]);
    }
    const r = tickReasons(report({ run: { calls: 3, n_429: 0, rejected: 0, incomplete: 0, conflicts: 2, lag_s: 1, unauthorized: ['AAPL', 'BAC'], key_failure: 1 } }), [
      { event: 'checker_diff' },
      { event: 'checker_stuck' },
      { event: 'internal_mismatch' },
      { event: 'feed_restored', symbol: 'MA' },
      { event: 'backfill' },
    ]);
    expect(r.reasons).toEqual(['key_failure', 'feed_unauthorized:AAPL,BAC', 'conflict', 'checker_diff', 'checker_stuck', 'internal_mismatch', 'feed_restored:MA']);
  });

  it('idle (record = 0) is healthy: the operator turned recording off', () => {
    expect(tickReasons(report({ outcome: 'idle' }), []).reasons).toEqual([]);
  });
});

describe('hourly thresholds (pure, plan 12)', () => {
  const row = (feed: string, o: Partial<HourRow> = {}): HourRow => ({ feed, incomplete: 0, empty: 0, empty_after_open: 0, stale: 0, rejected: 0, reports: 100, ...o });
  it('at each threshold nothing; one past it alerts, by symbol', () => {
    expect(hourReasons([row('BTC', { incomplete: 5, stale: 15, rejected: 5 }), row('EURUSD', { empty: 9, empty_after_open: 5 })])).toEqual([]);
    expect(hourReasons([row('BTC', { incomplete: 6 })])).toEqual(['incomplete:BTC']);
    expect(hourReasons([row('BTC', { stale: 16 })])).toEqual(['stale:BTC']);
    expect(hourReasons([row('BTC', { rejected: 6 })])).toEqual(['rejects:BTC']);
    expect(hourReasons([row('EURUSD', { empty_after_open: 6 })])).toEqual(['empty:EURUSD']);
  });
  it('crypto alerts on any empty minute; an RWA feed only on empties that follow an open minute', () => {
    expect(hourReasons([row('ETH', { empty: 1 })])).toEqual(['empty:ETH']);
    expect(hourReasons([row('AAPL', { empty: 40, empty_after_open: 0 })])).toEqual([]);
    expect(hourReasons([row('ETH', { incomplete: 9 }), row('BTC', { incomplete: 9 })])).toEqual(['incomplete:BTC,ETH']);
  });
});

describe('conditions from D1', () => {
  it('rate_limited only when the newest 3 runs all saw a 429', async () => {
    const now = await d1Now();
    await db().prepare('INSERT INTO runs (t, n_429) VALUES (?1, 1), (?2, 1)').bind(now - 120, now - 60).run();
    expect(await dbReasons(db(), null)).toEqual([]);
    await db().prepare('INSERT INTO runs (t, n_429) VALUES (?1, 1)').bind(now).run();
    expect(await dbReasons(db(), null)).toEqual(['rate_limited']);
    await db().prepare('INSERT INTO runs (t, n_429) VALUES (?1, 0)').bind(now + 1).run();
    expect(await dbReasons(db(), null)).toEqual([]);
  });

  it('checker_stalled once the recorder has run 26 h with no cycle completed in 26 h; not before', async () => {
    const now = await d1Now();
    await db().prepare('INSERT INTO runs (t) VALUES (?1)').bind(now - 25 * 3600).run();
    expect(await dbReasons(db(), null)).toEqual([]);
    await db().prepare('INSERT INTO runs (t) VALUES (?1)').bind(now - 27 * 3600).run();
    expect(await dbReasons(db(), null)).toEqual(['checker_stalled']);
    await db()
      .prepare("INSERT INTO checker_cycle (id, started_at, anchor_day, feed_list_json, feed_list_hash, checker_version, shards_total, completed_at) VALUES (1, ?1, 0, '[]', 'h', 'v', 0, ?2)")
      .bind(now - 20 * 3600, now - 3600)
      .run();
    expect(await dbReasons(db(), null)).toEqual([]);
    // A cycle that completed, but more than 26 h ago, is stalled again.
    await db().prepare('UPDATE checker_cycle SET completed_at = ?1').bind(now - 27 * 3600).run();
    expect(await dbReasons(db(), null)).toEqual(['checker_stalled']);
  });

  it('the hourly read counts only minutes past the catch-up window, and empties after an open minute', async () => {
    const M = 1792177200; // an hourly tick
    const ins = (feed: string, t: number, state: string) =>
      db()
        .prepare(
          "INSERT INTO candles_1m (feed, t, state, o, h, l, c, n_reports, n_open, n_rejected, n_valid, n_raw, raw_rule, rules_version, tries) VALUES (?1, ?2, ?3, ?4, ?4, ?4, ?4, 0, 0, 0, 0, 0, 1, 'v', 0)",
        )
        .bind(feed, t, state, state === 'open' ? '1' : null);
    const rows = [];
    for (let i = 0; i < 6; i++) rows.push(ins('BTC', M - 4200 + i * 60, 'incomplete')); // the window's first minutes
    for (let i = 0; i < 9; i++) rows.push(ins('ETH', M - 600 + i * 60, 'incomplete')); // inside catch-up: not counted
    for (let i = 0; i < 6; i++) rows.push(ins('EURUSD', M - 3000 + i * 120, 'open'), ins('EURUSD', M - 3000 + i * 120 + 60, 'empty'));
    await db().batch(rows);
    expect(await dbReasons(db(), M)).toEqual(['incomplete:BTC', 'empty:EURUSD']);
    expect(await dbReasons(db(), M + 60)).toEqual([]); // not an hourly tick
  });
});

describe('the hourly on-chain sample', () => {
  const entry = capture('live-page-BTC')[0];
  const sample = { symbol: 'BTC', fullReport: String(entry.fullReport) };
  const blob = reportBlob(entry.fullReport)!;
  const ok = (bytes: Hex) => Response.json({ jsonrpc: '2.0', id: 1, result: encodeAbiParameters([{ type: 'bytes' }], [bytes]) });

  it('the verified bytes equal the recorder blob: match; other bytes or a revert: drift; no answer: unavailable', async () => {
    const asked = recorder(() => ok(blob));
    expect((await verifySample(asked.f, RPC, sample)).result).toBe('match');
    expect(JSON.parse(asked.calls[0].body)).toMatchObject({ method: 'eth_call', params: [{ to: '0x72790f9eB82db492a7DDb6d2af22A270Dcc3Db64' }, 'latest'] });
    expect((await verifySample(recorder(() => ok(`${blob.slice(0, -2)}00` as Hex)).f, RPC, sample)).result).toBe('drift');
    expect((await verifySample(recorder(() => Response.json({ error: { code: 3, message: 'execution reverted' } })).f, RPC, sample)).result).toBe('drift');
    expect((await verifySample(recorder(() => new Response('', { status: 502 })).f, RPC, sample)).result).toBe('unavailable');
    expect((await verifySample(recorder(() => Promise.reject(new Error('down'))).f, RPC, sample)).result).toBe('unavailable');
    expect((await verifySample(recorder(() => ok(blob)).f, RPC, { symbol: 'BTC', fullReport: '0xzz' })).result).toBe('drift');
    expect((await verifySample(recorder(() => Response.json({ result: '0x1234' })).f, RPC, sample)).result).toBe('drift'); // an answer that is not ABI bytes
  });

  it('drift alerts by symbol; an unreachable RPC is counted in the body, not alerted', async () => {
    const r = report({ samples: [sample, { ...sample, symbol: 'ETH' }] });
    const drift = recorder((url) => (url === RPC ? ok('0x00') : new Response('OK')));
    const a = await monitorRun({ db: undefined, fetchImpl: drift.f, pingUrl: HC, rpcUrl: RPC, log: () => {} }, r, []);
    expect(a.reasons).toEqual(['decode_drift:BTC,ETH']);
    const down = recorder((url) => (url === RPC ? new Response('', { status: 503 }) : new Response('OK')));
    const b = await monitorRun({ db: undefined, fetchImpl: down.f, pingUrl: HC, rpcUrl: RPC, log: () => {} }, r, []);
    expect(b.reasons).toEqual([]);
    expect(down.calls.at(-1)!.body).toContain('rpc_unavailable=2');
  });
});

describe('the ping', () => {
  it('healthy: one POST to the base URL; reasons: one POST to /fail with the codes first; no ping URL: none', async () => {
    const hc = recorder(() => new Response('OK'));
    await ping(hc.f, `${HC}/`, [], 'recorded minute=1');
    await ping(hc.f, HC, ['key_failure', 'conflict'], 'recorded minute=2');
    expect(hc.calls.map((c) => c.url)).toEqual([HC, `${HC}/fail`]);
    expect(hc.calls[1].body).toBe('key_failure conflict | recorded minute=2');
    const none = recorder(() => new Response('OK'));
    await monitorRun({ db: undefined, fetchImpl: none.f, pingUrl: undefined, rpcUrl: RPC, log: () => {} }, report(), []);
    expect(none.calls).toEqual([]);
  });

  it('a ping that fails or throws never throws out of the run', async () => {
    await expect(ping(recorder(() => Promise.reject(new Error('x'))).f, HC, [], 's')).resolves.toBeUndefined();
  });
});

describe('a whole scheduled run on local D1', () => {
  const runEnv = { DB: env.DB, DATASTREAMS_URL: BASE, DATASTREAMS_API_KEY: CREDS.apiKey, DATASTREAMS_API_SECRET: CREDS.secret, HEALTHCHECKS_PING_URL: HC, PUBLIC_RPC_URL: RPC };

  it('record = 0: the tick is idle and one healthy ping is sent, with no Data Streams call', async () => {
    const all = recorder(() => new Response('OK'));
    await scheduledRun(runEnv, all.f);
    expect(all.calls.map((c) => c.url)).toEqual([HC]);
    expect(all.calls[0].body).toMatch(/^idle minute=- /);
  });

  it('another tick holds the lease: no ping at all (Healthchecks reports the silence)', async () => {
    await db().prepare(`INSERT INTO lease (id, holder, until) VALUES (1, 'someone', CAST(strftime('%s','now') AS INTEGER) + 90) ON CONFLICT(id) DO UPDATE SET holder = excluded.holder, until = excluded.until`).run();
    const all = recorder(() => new Response('OK'));
    await scheduledRun(runEnv, all.f);
    expect(all.calls).toEqual([]);
  });

  it('no Data Streams secrets while recording: one /fail ping with no_credentials, and no secret in the body', async () => {
    await db().prepare('UPDATE config SET record = 1 WHERE id = 1').run();
    const all = recorder(() => new Response('OK'));
    await scheduledRun({ ...runEnv, DATASTREAMS_API_KEY: undefined, DATASTREAMS_API_SECRET: undefined }, all.f);
    expect(all.calls.map((c) => c.url)).toEqual([`${HC}/fail`]);
    expect(all.calls[0].body).toMatch(/^no_credentials key_failure \| no_credentials /); // a run without secrets is recorded as a key failure (tick.ts)
    for (const secret of [CREDS.apiKey, CREDS.secret, HC]) expect(all.calls[0].body).not.toContain(secret);
  });
});

describe('the tick hands the monitor its samples', () => {
  it('on the hourly tick one valid live report per feed; on any other tick none', async () => {
    const M = 1792076400; // 15:00 UTC, an hourly tick with a real BTC page (capture open-minute-BTC)
    await recordOnly(['BTC']);
    const clock = virtualClock(msForLive(M));
    const r = await tick(new FakeStreams(clock, [capture('open-minute-BTC')]), clock);
    expect(r.outcome).toBe('recorded');
    expect(r.samples.map((s) => s.symbol)).toEqual(['BTC']);
    expect(reportBlob(r.samples[0].fullReport)).not.toBeNull();
    await db().prepare('UPDATE lease SET until = 0').run();
    clock.advance(60_000);
    const r2 = await tick(new FakeStreams(clock, [capture('open-minute-BTC')]), clock);
    expect(r2.samples).toEqual([]);
  });
});
