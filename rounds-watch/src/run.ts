// One liveness-watch run (TASKS T2.0d, INVARIANTS N21). Alert-only: it reads the rounds contract and the
// Data Streams API, and it tells Joshua. It holds no wallet key and sends nothing on-chain.
//
// It alerts, once per round per condition, on:
//   - "unsettled": a two-sided round still not settled 30 minutes after closeTime;
//   - "no-price":  a round that refunded NoPrice;
// each saying whether Chainlink published a report for both of the round's seconds. That tells the two
// causes apart: reports exist but nobody delivered them (the keeper and CRE are down), or Chainlink has no
// signed price for that exact second, and the round will refund NoPrice whatever anyone does.
//
// A one-sided round never settles by design (it refunds OneSided), so it is not a liveness failure.
//
// Delivery: Telegram, and an alert counts as said only once Telegram confirms it; until then it is retried
// every run. Healthchecks is the independent path: it is pinged `/fail` while any round is in an alert
// condition or Telegram failed, and `ok` otherwise, so the alarm also arrives by email and a watch that
// stops running is caught by missing pings.

import { decodeFunctionResult, encodeFunctionData, type Hex } from 'viem';
import { readReport, reportHeaders, reportPath, type HmacHex } from '../../rounds-delivery/src/index';
import { REFUND_REASON, STATUS, WATCH_ABI } from './abi';
import { send, type Net } from './net';
import { rpcBatch, type RpcCall } from './rpc';
import type { AlertKind, Meta } from './state';

/// N21: a round unsettled this long after close is flagged.
export const UNSETTLED_ALERT_S = 30 * 60;
/// Rounds read per run. The contract caps non-terminal rounds at MAX_ACTIVE_ROUNDS (10), so the scan from
/// the cursor stays short; this bounds it anyway.
export const MAX_SCAN = 40;
/// Rounds whose reports are checked per run (2 Data Streams requests each). Later ones wait a run.
export const MAX_ALERTS_PER_RUN = 4;

export interface WatchConfig {
  roundsAddress: Hex;
  rpcUrl: string;
  datastreamsUrl: string;
  datastreamsKey: string;
  datastreamsSecret: string;
}

export interface WatchDeps {
  net: Net;
  state: {
    acquire(now: number): Promise<{ ok: true; token: number; meta: Meta } | { ok: false }>;
    commit(token: number, meta: Meta, now: number): Promise<{ ok: boolean }>;
  };
  hmac: HmacHex;
  /// Sends one Telegram message; true only if Telegram confirmed it.
  telegram(text: string): Promise<boolean>;
  ping(kind: 'ok' | 'fail', body: string): Promise<void>;
}

export type WatchStatus = 'quiet' | 'alerting' | 'telegram-failed' | 'rpc-error' | 'lease-held' | 'lease-lost';

export interface WatchOutcome {
  status: WatchStatus;
  /// The alert lines this run tried to deliver (secret-free).
  lines: string[];
  /// Rounds currently in an alert condition, delivered or not.
  conditions: string[];
}

interface RoundView {
  id: number;
  status: number;
  refundReason: number;
  startTime: number;
  closeTime: number;
  twoSided: boolean;
}

type ReportState = 'exists' | 'missing' | string;

const iso = (s: number) => new Date(s * 1000).toISOString().replace('.000Z', 'Z');

export async function runWatch(cfg: WatchConfig, deps: WatchDeps): Promise<WatchOutcome> {
  const now = deps.net.now();
  const acquired = await deps.state.acquire(now);
  if (!acquired.ok) return { status: 'lease-held', lines: [], conditions: [] };
  const meta: Meta = { ...acquired.meta, alerted: { ...acquired.meta.alerted } };

  let outcome: WatchOutcome;
  try {
    outcome = await watchOnce(cfg, deps, meta, Math.floor(now / 1000));
  } catch {
    // Reported by kind only: an error's text could carry a URL or the Telegram token.
    outcome = { status: 'rpc-error', lines: [], conditions: [] };
  }

  meta.lastStatus = outcome.status;
  meta.lastRunAt = deps.net.now();
  const committed = await deps.state.commit(acquired.token, meta, deps.net.now());
  if (!committed.ok) outcome = { ...outcome, status: 'lease-lost' };

  // An RPC failure sends no ping: a lasting one is caught by Healthchecks' missing pings, a brief one is not
  // worth an email.
  if (outcome.status === 'rpc-error' || outcome.status === 'lease-lost') return outcome;
  if (outcome.status === 'telegram-failed' || outcome.conditions.length > 0) {
    const body = ['mako-rounds-watch', ...outcome.conditions, ...(outcome.status === 'telegram-failed' ? ['TELEGRAM DELIVERY FAILED:', ...outcome.lines] : [])];
    await deps.ping('fail', body.join('\n'));
  } else {
    await deps.ping('ok', 'mako-rounds-watch quiet');
  }
  return outcome;
}

async function watchOnce(cfg: WatchConfig, deps: WatchDeps, meta: Meta, nowS: number): Promise<WatchOutcome> {
  const call = (data: Hex): RpcCall => ({ method: 'eth_call', params: [{ to: cfg.roundsAddress, data }, 'latest'] });
  const head = await rpcBatch(deps.net, cfg.rpcUrl, [
    call(encodeFunctionData({ abi: WATCH_ABI, functionName: 'roundCount' })),
    call(encodeFunctionData({ abi: WATCH_ABI, functionName: 'DURATION' })),
  ]);
  if (!head.ok || !head.items[0].ok || !head.items[1].ok) return { status: 'rpc-error', lines: [], conditions: [] };
  const count = Number(decodeFunctionResult({ abi: WATCH_ABI, functionName: 'roundCount', data: head.items[0].result as Hex }));
  const duration = Number(decodeFunctionResult({ abi: WATCH_ABI, functionName: 'DURATION', data: head.items[1].result as Hex }));

  const ids: number[] = [];
  for (let id = Math.max(1, meta.cursor); id <= count && ids.length < MAX_SCAN; id++) ids.push(id);
  const rounds: RoundView[] = [];
  if (ids.length > 0) {
    const res = await rpcBatch(
      deps.net,
      cfg.rpcUrl,
      ids.map((id) => call(encodeFunctionData({ abi: WATCH_ABI, functionName: 'roundOf', args: [BigInt(id)] }))),
    );
    if (!res.ok) return { status: 'rpc-error', lines: [], conditions: [] };
    for (let i = 0; i < ids.length; i++) {
      const it = res.items[i];
      if (!it.ok) return { status: 'rpc-error', lines: [], conditions: [] };
      const r = decodeFunctionResult({ abi: WATCH_ABI, functionName: 'roundOf', args: [0n], data: it.result as Hex });
      const start = Number(r.startTime);
      rounds.push({
        id: ids[i],
        status: Number(r.status),
        refundReason: Number(r.refundReason),
        startTime: start,
        closeTime: start + duration,
        twoSided: r.upPool > 0n && r.downPool > 0n,
      });
    }
  }

  // What is in an alert condition now, and what has not been said yet.
  const conditions: string[] = [];
  const due: { round: RoundView; kind: AlertKind }[] = [];
  for (const r of rounds) {
    const said = meta.alerted[String(r.id)] ?? {};
    if (r.status === STATUS.Active && r.twoSided && nowS - r.closeTime >= UNSETTLED_ALERT_S) {
      conditions.push(`round ${r.id} unsettled ${Math.floor((nowS - r.closeTime) / 60)} min after close`);
      if (said.unsettled === undefined) due.push({ round: r, kind: 'unsettled' });
    }
    if (r.status === STATUS.Refunded && r.refundReason === REFUND_REASON.NoPrice && said['no-price'] === undefined) {
      conditions.push(`round ${r.id} refunded NoPrice`);
      due.push({ round: r, kind: 'no-price' });
    }
  }

  // Report existence for the rounds being alerted this run.
  const lines: string[] = [];
  const delivered: { id: number; kind: AlertKind }[] = [];
  for (const { round, kind } of due.slice(0, MAX_ALERTS_PER_RUN)) {
    const start = await reportState(cfg, deps, round.startTime);
    const close = await reportState(cfg, deps, round.closeTime);
    lines.push(alertLine(round, kind, start, close, nowS));
    delivered.push({ id: round.id, kind });
  }

  let status: WatchStatus = conditions.length ? 'alerting' : 'quiet';
  if (lines.length > 0) {
    const text = ['Mako rounds watch', ...lines].join('\n\n');
    const ok = await deps.telegram(text.slice(0, 4000));
    if (ok) {
      const at = nowS * 1000;
      for (const d of delivered) meta.alerted[String(d.id)] = { ...(meta.alerted[String(d.id)] ?? {}), [d.kind]: at };
    } else {
      status = 'telegram-failed';
    }
  }

  // Advance past rounds that are terminal and have nothing left to say; forget what was said about them.
  let cursor = Math.max(1, meta.cursor);
  for (const r of rounds) {
    if (r.id !== cursor) break;
    const terminal = r.status === STATUS.Settled || r.status === STATUS.Refunded;
    const owesNoPrice = r.status === STATUS.Refunded && r.refundReason === REFUND_REASON.NoPrice && meta.alerted[String(r.id)]?.['no-price'] === undefined;
    if (!terminal || owesNoPrice) break;
    cursor++;
  }
  meta.cursor = cursor;
  for (const k of Object.keys(meta.alerted)) if (Number(k) < cursor) delete meta.alerted[k];

  return { status, lines, conditions };
}

async function reportState(cfg: WatchConfig, deps: WatchDeps, boundary: number): Promise<ReportState> {
  const path = reportPath(boundary);
  const headers = await reportHeaders(path, cfg.datastreamsKey, cfg.datastreamsSecret, String(deps.net.now()), deps.hmac);
  const res = await send(deps.net, cfg.datastreamsUrl + path, { method: 'GET', headers });
  if (!res.ok && res.status === undefined) return `unknown (${res.kind})`;
  const r = readReport(res.ok ? res.status : (res.status as number), res.ok ? res.text : (res.text ?? ''), null, boundary);
  if (r.ok) return 'exists';
  if (r.reason === 'not_found') return 'missing';
  return `unknown (${r.reason})`;
}

export function alertLine(r: RoundView, kind: AlertKind, start: ReportState, close: ReportState, nowS: number): string {
  const reports = `Chainlink reports: start ${iso(r.startTime)} ${start}, close ${iso(r.closeTime)} ${close}.`;
  let cause: string;
  if (start === 'exists' && close === 'exists')
    cause =
      kind === 'unsettled'
        ? 'Both reports exist, so this is a DELIVERY failure: the keeper and CRE are not settling. Anyone with Data Streams access can settle it.'
        : 'Both reports existed, so the round refunded because nobody delivered them within 24 hours.';
  else if (start === 'missing' || close === 'missing')
    cause =
      kind === 'unsettled'
        ? 'Chainlink has no report for that second, so the round cannot settle and will refund NoPrice at its deadline.'
        : 'Chainlink had no report for that second, so no one could have settled it.';
  else cause = 'Report availability could not be checked this run.';
  const head =
    kind === 'unsettled'
      ? `Round ${r.id} is UNSETTLED ${Math.floor((nowS - r.closeTime) / 60)} min after close.`
      : `Round ${r.id} REFUNDED NoPrice.`;
  return `${head} ${reports} ${cause}`;
}
