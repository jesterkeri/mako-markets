// ----------------------------------------------------------------------------
// price-recorder/src/monitor.ts
//
// Monitoring (CHARTS_DS_PLAN 12; unit f), for the minute layer. After every tick the Worker sends ONE Healthchecks
// ping (the keeper's pattern, keeper/src/index.ts): the check's base URL when the tick is healthy, `/fail` with the
// reason codes when any alert condition below holds, and nothing when the tick could not run at all (another tick
// held the lease): Healthchecks' period and grace then report a recorder that stops ticking or keeps colliding.
// Healthchecks emails on the change to down and back, so a condition that lasts sends one alert, not one a minute.
// Bodies carry codes, symbols and counts only, never a response body or a secret.
//
// Conditions, from the tick (outcome, runs row, logged events):
//   tick_failed / batch_failed / lease_lost / deadline / config_invalid / no_credentials: the tick wrote nothing
//   key_failure: a whole-key failure (4.1);  feed_unauthorized:SYM,...: per-feed refusals this tick (4.1)
//   conflict: this tick recorded a contradiction (3.5);  internal_mismatch: a determinism bug (3.5)
//   checker_diff / checker_stuck: the invariant checker (3.6);  feed_restored:SYM: a listed feed answers again (4.1)
// From D1, every tick (one statement):
//   rate_limited: the newest 3 runs rows all saw a 429;  checker_stalled: no cycle completed in 26 h, once the
//   recorder has run for 26 h (the first cycle takes about 17.6 h)
// From D1, on the hourly tick, over the hour's minutes that are past the 10-minute catch-up window (one statement):
//   incomplete:SYM (> 5);  empty:SYM (crypto: any; others: > 5 that follow an open minute);  stale:SYM (> 15);
//   rejects:SYM (> 5 % of the minute reports rejected)
// On the hourly tick, after the tick: one live report per feed verified through VerifierProxy.verify by eth_call on
// the public Monad RPC (no key; the resolver's address, cf-worker/src/datastreams.ts:15); the returned bytes must
// equal the recorder's own blob of that report (envelope.ts), else decode_drift:SYM. An unreachable RPC is counted in
// the body, not alerted (it says nothing about the recorder).
// ----------------------------------------------------------------------------

import { decodeFunctionResult, encodeFunctionData, type Hex } from 'viem';
import { VERIFIER_PROXY } from '../../cf-worker/src/datastreams';
import { reportBlob } from './envelope';
import { FEED_BY_SYMBOL } from './feeds';
import { D1_NOW } from './lease';
import { HOUR } from './rollup';
import type { TickReport } from './tick';

export const DEFAULT_PUBLIC_RPC_URL = 'https://testnet-rpc.monad.xyz';
export const STALLED_S = 26 * HOUR;
export const CATCHUP_S = 600;
export const VERIFY_CONCURRENCY = 4;
export const VERIFY_TIMEOUT_MS = 8_000;
export const PING_TIMEOUT_MS = 10_000;

const FAILED_OUTCOMES = new Set(['tick_failed', 'batch_failed', 'lease_lost', 'deadline', 'config_invalid', 'no_credentials']);
const EVENT_CODES = new Set(['checker_diff', 'checker_stuck', 'internal_mismatch']);

/// `ping` false: send no ping (the tick did not run: another holds the lease). Otherwise the reasons; none is healthy.
export type Assessment = { ping: boolean; reasons: string[] };

/// The conditions that come from the tick alone (pure).
export function tickReasons(report: TickReport, events: readonly Record<string, unknown>[]): Assessment {
  if (report.outcome === 'lease_busy') return { ping: false, reasons: [] };
  const reasons: string[] = [];
  if (FAILED_OUTCOMES.has(report.outcome)) reasons.push(report.outcome);
  const run = report.run;
  if (run?.key_failure === 1) reasons.push('key_failure');
  if (run && run.unauthorized.length > 0) reasons.push(`feed_unauthorized:${run.unauthorized.join(',')}`);
  if (run && run.conflicts > 0) reasons.push('conflict');
  for (const code of EVENT_CODES) if (events.some((e) => e.event === code)) reasons.push(code);
  const restored = events.filter((e) => e.event === 'feed_restored').map((e) => String(e.symbol));
  if (restored.length > 0) reasons.push(`feed_restored:${restored.join(',')}`);
  return { ping: true, reasons };
}

export const STATE_SQL =
  `SELECT ${D1_NOW} AS now, (SELECT COUNT(*) FROM (SELECT n_429 FROM runs ORDER BY t DESC LIMIT 3) WHERE n_429 > 0) AS r429, ` +
  `(SELECT COUNT(*) FROM runs) AS nruns, (SELECT MIN(t) FROM runs) AS first_run, (SELECT MAX(completed_at) FROM checker_cycle) AS last_cycle`;

/// ?1 the hour's first minute, ?2 the first minute still inside the catch-up window. Empty minutes count for an RWA
/// feed only after an open minute (a feed going from open straight to empty, not a market closing).
export const HOURLY_SQL =
  `SELECT feed, SUM(state = 'incomplete') AS incomplete, SUM(state = 'empty') AS empty, ` +
  `SUM(state = 'empty' AND prev = 'open') AS empty_after_open, SUM(state = 'stale') AS stale, ` +
  `SUM(n_rejected) AS rejected, SUM(n_reports) AS reports FROM (` +
  `SELECT feed, t, state, n_rejected, n_reports, LAG(state) OVER (PARTITION BY feed ORDER BY t) AS prev FROM candles_1m ` +
  `WHERE t >= ?1 - 60 AND t < ?2) WHERE t >= ?1 GROUP BY feed`;

export type HourRow = { feed: string; incomplete: number; empty: number; empty_after_open: number; stale: number; rejected: number; reports: number };

/// Plan 12's per-feed thresholds over one hour (pure).
export function hourReasons(rows: readonly HourRow[]): string[] {
  const by = (code: string, test: (r: HourRow) => boolean) => {
    const syms = rows.filter(test).map((r) => r.feed).sort();
    return syms.length > 0 ? [`${code}:${syms.join(',')}`] : [];
  };
  const crypto = (r: HourRow) => FEED_BY_SYMBOL.get(r.feed)?.class === 'crypto';
  return [
    ...by('incomplete', (r) => r.incomplete > 5),
    ...by('empty', (r) => (crypto(r) ? r.empty > 0 : r.empty_after_open > 5)),
    ...by('stale', (r) => r.stale > 15),
    ...by('rejects', (r) => r.reports > 0 && r.rejected * 100 > r.reports * 5),
  ];
}

/// The D1 conditions: every tick the 429 run and the stalled checker; on the hourly tick the per-feed thresholds.
export async function dbReasons(db: D1Database, minute: number | null): Promise<string[]> {
  const s = await db.prepare(STATE_SQL).first<{ now: number; r429: number; nruns: number; first_run: number | null; last_cycle: number | null }>();
  if (!s) throw new Error('monitor state read returned no row');
  const reasons: string[] = [];
  if (s.nruns >= 3 && s.r429 === 3) reasons.push('rate_limited');
  if (s.first_run !== null && s.first_run <= s.now - STALLED_S && (s.last_cycle === null || s.last_cycle < s.now - STALLED_S)) reasons.push('checker_stalled');
  if (minute !== null && minute % HOUR === 0) {
    const res = await db.prepare(HOURLY_SQL).bind(minute - HOUR, minute - CATCHUP_S).all<HourRow>();
    reasons.push(...hourReasons(res.results));
  }
  return reasons;
}

const verifyAbi = [
  { type: 'function', name: 'verify', stateMutability: 'payable', inputs: [{ name: 'payload', type: 'bytes' }, { name: 'parameterPayload', type: 'bytes' }], outputs: [{ name: '', type: 'bytes' }] },
] as const;

export type SampleResult = { symbol: string; result: 'match' | 'drift' | 'unavailable' };

/// One sample: eth_call VerifierProxy.verify(fullReport, "") at `latest`; the verified bytes must equal the blob the
/// recorder decodes. A revert or different bytes is drift; no answer is unavailable.
export async function verifySample(fetchImpl: typeof fetch, rpcUrl: string, s: { symbol: string; fullReport: string }): Promise<SampleResult> {
  const blob = reportBlob(s.fullReport);
  if (!blob) return { symbol: s.symbol, result: 'drift' };
  const data = encodeFunctionData({ abi: verifyAbi, functionName: 'verify', args: [s.fullReport as Hex, '0x'] });
  try {
    const res = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: VERIFIER_PROXY, data }, 'latest'] }),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    if (!res.ok) return { symbol: s.symbol, result: 'unavailable' };
    const body = (await res.json()) as { result?: unknown; error?: { code?: unknown; message?: unknown } };
    if (typeof body.result !== 'string') {
      const msg = typeof body.error?.message === 'string' ? body.error.message : '';
      return { symbol: s.symbol, result: body.error?.code === 3 || /revert/i.test(msg) ? 'drift' : 'unavailable' };
    }
    const verified = decodeFunctionResult({ abi: verifyAbi, functionName: 'verify', data: body.result as Hex }).toLowerCase();
    return { symbol: s.symbol, result: verified === blob ? 'match' : 'drift' };
  } catch {
    return { symbol: s.symbol, result: 'unavailable' };
  }
}

export async function verifySamples(fetchImpl: typeof fetch, rpcUrl: string, samples: readonly { symbol: string; fullReport: string }[]): Promise<SampleResult[]> {
  const out: SampleResult[] = [];
  for (let i = 0; i < samples.length; i += VERIFY_CONCURRENCY) {
    out.push(...(await Promise.all(samples.slice(i, i + VERIFY_CONCURRENCY).map((s) => verifySample(fetchImpl, rpcUrl, s)))));
  }
  return out;
}

/// The one ping of the run. Best effort: a failed ping is reported by its absence.
export async function ping(fetchImpl: typeof fetch, url: string, reasons: readonly string[], status: string): Promise<void> {
  const base = url.trim().replace(/\/$/, '');
  const body = reasons.length > 0 ? `${reasons.join(' ')} | ${status}` : status;
  try {
    await fetchImpl(reasons.length > 0 ? `${base}/fail` : base, { method: 'POST', body: body.slice(0, 1000), signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
  } catch {
    /* reported by absence */
  }
}

/// The status line of a run: the tick's counts, never a body or a secret.
export function statusLine(report: TickReport, samples: readonly SampleResult[]): string {
  const r = report.run;
  const parts = [report.outcome, `minute=${report.minute ?? '-'}`];
  if (r) parts.push(`calls=${r.calls}`, `n429=${r.n_429}`, `incomplete=${r.incomplete}`, `conflicts=${r.conflicts}`, `lag=${r.lag_s ?? '-'}`);
  if (samples.length > 0) parts.push(`verified=${samples.filter((s) => s.result === 'match').length}/${samples.length}`, `rpc_unavailable=${samples.filter((s) => s.result === 'unavailable').length}`);
  return parts.join(' ');
}

/// The whole monitor step after a tick.
export async function monitorRun(
  deps: { db: D1Database | undefined; fetchImpl: typeof fetch; pingUrl: string | undefined; rpcUrl: string; log: (e: Record<string, unknown>) => void },
  report: TickReport,
  events: readonly Record<string, unknown>[],
): Promise<Assessment & { samples: SampleResult[] }> {
  const t = tickReasons(report, events);
  if (!t.ping) return { ...t, samples: [] };
  const reasons = [...t.reasons];
  if (deps.db && report.outcome !== 'config_invalid') {
    try {
      reasons.push(...(await dbReasons(deps.db, report.minute)));
    } catch (e) {
      reasons.push('monitor_read_failed');
      deps.log({ event: 'monitor_read_failed', error: e instanceof Error ? e.name : 'error' });
    }
  }
  const samples = report.samples.length > 0 ? await verifySamples(deps.fetchImpl, deps.rpcUrl, report.samples) : [];
  const drift = samples.filter((s) => s.result === 'drift').map((s) => s.symbol).sort();
  if (drift.length > 0) reasons.push(`decode_drift:${drift.join(',')}`);
  const status = statusLine(report, samples);
  deps.log({ event: 'monitor', reasons, status });
  if (deps.pingUrl?.trim()) await ping(deps.fetchImpl, deps.pingUrl, reasons, status);
  return { ping: true, reasons, samples };
}
