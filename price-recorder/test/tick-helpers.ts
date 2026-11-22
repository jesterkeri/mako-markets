// Test doubles for the tick (CHARTS_DS_PLAN 4.1 to 4.4, 15.2). Nothing here leaves the machine:
//   * a virtual clock: `sleep` moves time forward at once, so a tick's 45 s window and 8/s pacing run in microseconds;
//   * FakeStreams, a Data Streams provider whose whole history is the captured reports (test/fixtures, PROVENANCE.md):
//     `/reports/page` answers the reports of the feed with obs >= startTimestamp, in obs order, at most `limit`, as the
//     real API does (inclusive start, measured 2026-10-16). Seconds no capture holds do not exist for it, so a minute
//     before a capture is honestly `empty` for this provider. A test can override any answer; a status other than
//     200 on a real body is labelled "synthetic status" in the test's name. Every request's HMAC headers are checked
//     against the resolver's own signing code.
//   * the dummy credentials below are not a credential: no real key or secret is ever used in a test.
import { env } from 'cloudflare:test';

import { hmacSha256Hex, signingString } from '../../cf-worker/src/datastreams';
import type { PageEntry } from '../src/entry';
import { FEEDS } from '../src/feeds';
import type { Clock } from '../src/limiter';
import { runTick, type TickDeps, type TickReport } from '../src/tick';
import followup from './fixtures/capture-followup-2026-10-16/summary.json';

export const CREDS = { apiKey: 'test-api-key-not-a-credential', secret: 'test-secret-not-a-credential' };
export const BASE = 'https://datastreams.fake';

/// The real refusal body Chainlink sent for BAC on /reports/page, 2026-10-16 (status 401).
export const REFUSAL_BODY: string = followup.results['now-BAC'].page.error;
export const REFUSAL_STATUS: number = followup.results['now-BAC'].page.status;
/// A real 400 body from the same run (`limit` 101), used as "another error text".
export const OTHER_ERROR_BODY: string = followup.results['limit-101'].error;

export type VirtualClock = Clock & { advance(ms: number): void };
export function virtualClock(startMs: number): VirtualClock {
  let now = startMs;
  return {
    now: () => now,
    sleep: async (ms) => {
      now += Math.max(0, ms);
    },
    advance: (ms) => {
      now += ms;
    },
  };
}

export type Call = { feedId: string; start: number; limit: number; atMs: number; signedOk: boolean };
export type Answer = { status: number; body: string };
export type Override = (call: Call, index: number) => Answer | null | Promise<Answer | null>;

const obs = (e: PageEntry) => Number(e.observationsTimestamp);

export class FakeStreams {
  readonly calls: Call[] = [];
  private readonly byFeed = new Map<string, PageEntry[]>();

  constructor(
    private readonly clock: Clock,
    sources: readonly (readonly PageEntry[])[],
    public override: Override | null = null,
  ) {
    for (const src of sources)
      for (const e of src) {
        const id = String(e.feedID).toLowerCase();
        const list = this.byFeed.get(id) ?? [];
        // The captures repeat the boundary second of an inclusive restart; one copy per identical report.
        if (!list.some((x) => obs(x) === obs(e) && x.fullReport === e.fullReport)) list.push(e);
        this.byFeed.set(id, list);
      }
    for (const list of this.byFeed.values()) list.sort((a, b) => obs(a) - obs(b));
  }

  callsFor(symbol: string): Call[] {
    const id = FEEDS.find((f) => f.symbol === symbol)?.feedId;
    return this.calls.filter((c) => c.feedId === id);
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== BASE || url.pathname !== '/api/v1/reports/page') throw new Error(`unexpected request ${url.origin}${url.pathname}`);
    const h = new Headers(init?.headers);
    const ts = h.get('X-Authorization-Timestamp') ?? '';
    const want = await hmacSha256Hex(CREDS.secret, signingString(`${url.pathname}${url.search}`, CREDS.apiKey, ts));
    const call: Call = {
      feedId: (url.searchParams.get('feedID') ?? '').toLowerCase(),
      start: Number(url.searchParams.get('startTimestamp')),
      limit: Number(url.searchParams.get('limit')),
      atMs: this.clock.now(),
      signedOk: h.get('Authorization') === CREDS.apiKey && ts === String(this.clock.now()) && h.get('X-Authorization-Signature-SHA256') === want,
    };
    const index = this.calls.push(call) - 1;
    const o = this.override ? await this.override(call, index) : null;
    if (o) return new Response(o.body, { status: o.status });
    const page = (this.byFeed.get(call.feedId) ?? []).filter((e) => obs(e) >= call.start).slice(0, call.limit);
    return Response.json({ reports: page });
  };
}

/// Config for a test: recording on, and every feed refused by config except `only` (so only those are requested).
export async function recordOnly(only: readonly string[] | 'all', record: 0 | 1 = 1): Promise<void> {
  const refused = only === 'all' ? [] : FEEDS.map((f) => f.symbol).filter((s) => !only.includes(s));
  // `record` is written as a literal: D1 binds a JS number as REAL, which the typeof CHECK on config refuses.
  await env.DB.prepare(`UPDATE config SET record = ${record}, feeds_refused = ?1 WHERE id = 1`).bind(JSON.stringify(refused)).run();
}

export type Tick = TickReport & { events: Record<string, unknown>[] };

export async function tick(fake: FakeStreams, clock: Clock, over: Partial<TickDeps> = {}): Promise<Tick> {
  const events: Record<string, unknown>[] = [];
  const r = await runTick({ db: env.DB, fetchImpl: fake.fetch, base: BASE, creds: CREDS, clock, log: (e) => events.push(e), ...over });
  return { ...r, events };
}

export const rows = async (sql: string, ...args: unknown[]): Promise<Record<string, unknown>[]> =>
  (await env.DB.prepare(sql).bind(...args).all<Record<string, unknown>>()).results;

export const d1Now = async (): Promise<number> => Number((await rows("SELECT CAST(strftime('%s', 'now') AS INTEGER) AS n"))[0].n);

/// Every table a tick may write, for whole-database comparisons (`lease` and `runs` hold run-specific values).
export async function snapshot(): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const t of ['candles_1m', 'candles_15m', 'candles_1h', 'candles_1d', 'latest', 'conflicts', 'feed_holds'])
    out[t] = (await rows(`SELECT * FROM ${t} ORDER BY 1, 2`)).map((r) => (t === 'conflicts' || t === 'feed_holds' ? { ...r, seen_at: undefined, since: undefined } : r));
  return out;
}

/// The worker time at which the live minute is M (90 s after M plus `extraS`).
export const msForLive = (M: number, extraS = 0): number => (M + 90 + extraS) * 1000;

/// A D1Database that counts every statement it runs (each statement of a batch counts, plan 4.2).
export function countingDb(db: D1Database): { db: D1Database; count: () => number } {
  let n = 0;
  const inner = new WeakMap<object, D1PreparedStatement>();
  const wrap = (s: D1PreparedStatement): D1PreparedStatement => {
    const p = new Proxy(s, {
      get(t, k) {
        if (k === 'bind') return (...a: unknown[]) => wrap(t.bind(...a));
        if (k === 'all' || k === 'first' || k === 'run' || k === 'raw')
          return (...a: unknown[]) => {
            n++;
            return (t[k] as (...x: unknown[]) => unknown)(...a);
          };
        const v = (t as unknown as Record<PropertyKey, unknown>)[k];
        return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(t) : v;
      },
    });
    inner.set(p, s);
    return p;
  };
  const proxy = new Proxy(db, {
    get(t, k) {
      if (k === 'prepare') return (sql: string) => wrap(t.prepare(sql));
      if (k === 'batch')
        return (stmts: D1PreparedStatement[]) => {
          n += stmts.length;
          return t.batch(stmts.map((s) => inner.get(s) ?? s));
        };
      const v = (t as unknown as Record<PropertyKey, unknown>)[k];
      return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(t) : v;
    },
  });
  return { db: proxy, count: () => n };
}
