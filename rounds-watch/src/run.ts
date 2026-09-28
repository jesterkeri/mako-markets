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
import type { AlertKind, Evidence, Meta } from './state';

/// N21: a round unsettled this long after close is flagged.
export const UNSETTLED_ALERT_S = 30 * 60;
/// New round ids read per run by the history scan. Rounds are created far more slowly than 40 per 5 minutes.
export const MAX_SCAN = 40;
/// Round ids re-read per run from the open set. The contract caps non-terminal rounds at MAX_ACTIVE_ROUNDS
/// (10); the rest of the set is NoPrice alerts not yet delivered.
export const MAX_OPEN = 40;
/// Report checks per run (2 Data Streams requests each). Checks rotate: rounds with no check yet go first,
/// then the oldest check, so every due round is checked within a bounded number of runs, Telegram or not.
export const MAX_CHECKS_PER_RUN = 4;
/// A report check this old is repeated, so an "unknown" or "missing" is not kept forever.
export const EVIDENCE_TTL_MS = 30 * 60_000;

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
/// Telegram's limit is 4,096 characters; leave room.
const TELEGRAM_CHARS = 4000;

const iso = (s: number) => new Date(s * 1000).toISOString().replace('.000Z', 'Z');

export async function runWatch(cfg: WatchConfig, deps: WatchDeps): Promise<WatchOutcome> {
  const now = deps.net.now();
  const acquired = await deps.state.acquire(now);
  if (!acquired.ok) return { status: 'lease-held', lines: [], conditions: [] };
  // historyCursor, open and evidence arrived in the second version of this state; default them.
  const m = acquired.meta as Partial<Meta> & { cursor?: number };
  const meta: Meta = {
    historyCursor: m.historyCursor ?? m.cursor ?? 1,
    open: [...(m.open ?? [])],
    alerted: { ...(m.alerted ?? {}) },
    evidence: { ...(m.evidence ?? {}) },
    lastStatus: m.lastStatus ?? null,
    lastRunAt: m.lastRunAt ?? null,
  };

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

  // Two sources, so an old open round can never hide a newer one (Codex T2.0d r1): the open set, re-read
  // every run, and the next new ids from the history cursor, which always moves forward.
  const open = [...new Set(meta.open)].sort((a, b) => a - b).slice(0, MAX_OPEN);
  const fresh: number[] = [];
  for (let id = Math.max(1, meta.historyCursor); id <= count && fresh.length < MAX_SCAN; id++) fresh.push(id);
  const ids = [...new Set([...open, ...fresh])];

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

  // Report checks, rotating across every due round: never checked first, then the oldest check. A due
  // round waits for its check before it is alerted, since N21's alert must carry the report state.
  const nowMs = nowS * 1000;
  const needCheck = due
    .filter(({ round }) => {
      const e = meta.evidence[String(round.id)];
      return e === undefined || nowMs - e.at >= EVIDENCE_TTL_MS;
    })
    .sort((a, b) => (meta.evidence[String(a.round.id)]?.at ?? -1) - (meta.evidence[String(b.round.id)]?.at ?? -1) || a.round.id - b.round.id);
  const checked = new Set<number>();
  for (const { round } of needCheck) {
    if (checked.has(round.id)) continue;
    if (checked.size >= MAX_CHECKS_PER_RUN) break;
    checked.add(round.id);
    meta.evidence[String(round.id)] = {
      start: await reportState(cfg, deps, round.startTime),
      close: await reportState(cfg, deps, round.closeTime),
      at: deps.net.now(),
    };
  }

  const ready = due.filter(({ round }) => meta.evidence[String(round.id)] !== undefined);
  const lines = ready.map(({ round, kind }) => alertLine(round, kind, meta.evidence[String(round.id)], nowS));

  // Telegram: as many whole lines as fit in one message; only those count as delivered on success.
  let status: WatchStatus = conditions.length ? 'alerting' : 'quiet';
  const header = 'Mako rounds watch';
  let text = header;
  let included = 0;
  for (const l of lines) {
    if (text.length + 2 + l.length > TELEGRAM_CHARS) break;
    text += '\n\n' + l;
    included++;
  }
  if (included > 0) {
    const ok = await deps.telegram(text);
    if (ok) {
      for (const { round, kind } of ready.slice(0, included))
        meta.alerted[String(round.id)] = { ...(meta.alerted[String(round.id)] ?? {}), [kind]: nowMs };
    } else {
      status = 'telegram-failed';
    }
  }

  // The open set: non-terminal rounds, and NoPrice refunds whose alert is not yet delivered. The history
  // cursor moves past every id it read, whatever its state.
  const stillOpen = rounds.filter(
    (r) =>
      r.status === STATUS.Active ||
      r.status === STATUS.None ||
      (r.status === STATUS.Refunded && r.refundReason === REFUND_REASON.NoPrice && meta.alerted[String(r.id)]?.['no-price'] === undefined),
  );
  meta.open = stillOpen.map((r) => r.id);
  if (fresh.length) meta.historyCursor = fresh[fresh.length - 1] + 1;
  const keep = new Set(meta.open.map(String));
  for (const k of Object.keys(meta.alerted)) if (!keep.has(k)) delete meta.alerted[k];
  for (const k of Object.keys(meta.evidence)) if (!keep.has(k)) delete meta.evidence[k];

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

export function alertLine(r: RoundView, kind: AlertKind, e: Evidence, nowS: number): string {
  const checkedAt = iso(Math.floor(e.at / 1000));
  const reports = `At ${checkedAt} the Data Streams API returned: start ${iso(r.startTime)} ${e.start}, close ${iso(r.closeTime)} ${e.close}.`;
  if (kind === 'no-price') {
    // A check made after the refund cannot say why it happened (Codex T2.0d r1): a report may have appeared
    // only after the deadline. So it states what the API returned, and nothing more.
    return `Round ${r.id} REFUNDED NoPrice. ${reports}`;
  }
  let cause: string;
  if (e.start === 'exists' && e.close === 'exists')
    cause = 'Both reports exist inside the settlement window, so this is a DELIVERY failure: the keeper and CRE are not settling. Anyone with Data Streams access can settle it.';
  else if (e.start === 'missing' || e.close === 'missing')
    cause = 'A report is missing for that second; if it never appears, the round cannot settle and refunds NoPrice at its deadline.';
  else cause = 'Report availability could not be checked; the next check repeats it.';
  return `Round ${r.id} is UNSETTLED ${Math.floor((nowS - r.closeTime) / 60)} min after close. ${reports} ${cause}`;
}
