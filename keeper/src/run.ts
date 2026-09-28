// One keeper run (SPEC §5.5, TASKS T2.0c). Every I/O dependency is injected, so the whole run is testable
// against a fake chain and a fake Data Streams API.
//
// Order of a run:
//   1. the transaction from an earlier run, if any, is resolved before anything new is sent;
//   2. read `pendingSettlement()` and each candidate's close time; pick one round 5+ minutes past close;
//   3. fetch its two reports, each checked for the feed and the exact boundary second;
//   4. simulate `settle` and estimate its gas, in the same batch as the fee and balance reads;
//   5. sign, RECORD the transaction under the lease, and only then send it.
//
// Every run ends in exactly one status. Nothing fails silently: an unhealthy status that lasts 5 minutes is
// reported to Healthchecks as a failure, and a run that stops running at all is caught by Healthchecks'
// missing pings (Joshua, 2026-09-28: "alert rather than silently missing settlement").

import { keccak256, type Hex } from 'viem';
import {
  closeTimeData,
  decodeCloseTime,
  decodeDuration,
  decodePending,
  durationData,
  pendingSettlementData,
  pickRound,
  readReport,
  reportHeaders,
  reportPath,
  revertName,
  SETTLE_GAS_CEILING,
  settleData,
  type Due,
  type HmacHex,
} from '../../rounds-delivery/src/index';
import { send, type Net } from './net';
import { hexQuantity, rpcBatch, safeQuantity, type RpcCall, type RpcItem } from './rpc';
import type { InFlight, Meta } from './state';

export const CHAIN_ID = 10143;
/// SPEC §5.5 step 4: a missing report is retried every run and alerted after 30 minutes.
export const REPORT_MISSING_ALERT_S = 30 * 60;
/// A transaction with no receipt and an unconsumed nonce after this long is treated as dropped.
export const TX_STUCK_MS = 3 * 60_000;
/// An unhealthy condition must persist this long, from the start of the run that first saw it, before it is
/// reported, so one rate-limited minute does not page. Four minutes, not five: a failure can begin up to a
/// minute before the next run sees it, and T0.1c wants the alert within 5 minutes of the first failure.
export const UNHEALTHY_REPORT_MS = 4 * 60_000;
/// Transactions for one round that revert on chain or are dropped, after which it is no longer sent.
export const MAX_TX_FAILURES = 2;
/// Gas balance for fewer than this many settlements is reported, so it is topped up before it runs out.
export const LOW_BALANCE_SETTLEMENTS = 20n;

export type Healthy =
  | 'settled'
  | 'sent'
  | 'dry-run-would-send'
  | 'nothing-due'
  | 'waiting-report'
  | 'already-settled'
  | 'tx-pending'
  | 'lease-held';
export type Unhealthy =
  | 'rpc-rate-limited'
  | 'rpc-error'
  | 'report-api-error'
  | 'report-missing-30m'
  | 'simulation-reverted'
  | 'gas-over-budget'
  | 'low-gas-balance'
  | 'sent-low-gas'
  | 'tx-reverted'
  | 'tx-dropped'
  | 'lease-lost';
export type Status = Healthy | Unhealthy;

/// Statuses that show the keeper working, and so end an unhealthy stretch. `sent`, `tx-pending` and
/// `lease-held` are neutral: they neither start nor end one, so a transaction that reverts every time
/// (sent, reverted, sent, ...) still reaches Healthchecks (adversary pass, 2026-09-28).
const CLEARING = new Set<Status>(['settled', 'nothing-due', 'dry-run-would-send', 'waiting-report', 'already-settled']);

const UNHEALTHY = new Set<Status>([
  'rpc-rate-limited',
  'rpc-error',
  'report-api-error',
  'report-missing-30m',
  'simulation-reverted',
  'gas-over-budget',
  'low-gas-balance',
  'sent-low-gas',
  'tx-reverted',
  'tx-dropped',
  'lease-lost',
]);
export const isUnhealthy = (s: Status): boolean => UNHEALTHY.has(s);

export interface Outcome {
  status: Status;
  /// Short, secret-free: a round id, an error name, a tx hash, a reason code. Never a URL or a header.
  detail?: string;
  /// The earlier transaction's result, when this run resolved it and went on to the next round.
  prior?: Outcome;
  /// A condition that is unhealthy whatever this run's own status: a pending round 30+ minutes past close,
  /// or one no longer sent after repeated failed transactions. Raised every run while it holds, so a failing
  /// round cannot hide between other rounds' healthy runs.
  alarm?: string;
}

const line = (o: Outcome): string => (o.detail ? `${o.status}:${o.detail}` : o.status);
export function describe(o: Outcome): string {
  return [line(o), o.prior ? `after ${line(o.prior)}` : null, o.alarm ? `ALARM ${o.alarm}` : null].filter(Boolean).join(' | ');
}
export const unhealthyRun = (o: Outcome): boolean =>
  isUnhealthy(o.status) || (o.prior !== undefined && isUnhealthy(o.prior.status)) || o.alarm !== undefined;

export interface RunConfig {
  roundsAddress: Hex;
  keeperAddress: Hex;
  rpcUrl: string;
  datastreamsUrl: string;
  datastreamsKey: string;
  datastreamsSecret: string;
  dryRun: boolean;
}

export interface TxRequest {
  to: Hex;
  data: Hex;
  nonce: number;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface StateStub {
  acquire(now: number): Promise<{ ok: true; token: number; meta: Meta } | { ok: false }>;
  recordInFlight(token: number, inFlight: InFlight, now: number): Promise<{ ok: boolean }>;
  commit(token: number, meta: Meta, now: number): Promise<{ ok: boolean }>;
}

export interface Deps {
  net: Net;
  state: StateStub;
  /// Signs an EIP-1559 transaction for CHAIN_ID and returns the serialized bytes.
  sign(tx: TxRequest): Promise<Hex>;
  hmac: HmacHex;
  /// Healthchecks: `ok` on a healthy run, `fail` (with the status line) once unhealthy for 5 minutes.
  ping(kind: 'ok' | 'fail', body: string): Promise<void>;
}

// ---------------------------------------------------------------------------------------------------------

export async function runKeeper(cfg: RunConfig, deps: Deps): Promise<Outcome> {
  const now = deps.net.now();
  const acquired = await deps.state.acquire(now);
  if (!acquired.ok) return { status: 'lease-held' };
  const { token } = acquired;
  // attempts and txFailures arrived after the first deployments of this state; default them.
  const meta: Meta = { ...acquired.meta, attempts: { ...(acquired.meta.attempts ?? {}) }, txFailures: { ...(acquired.meta.txFailures ?? {}) } };

  let outcome: Outcome;
  try {
    outcome = await settleOne(cfg, deps, token, meta);
  } catch {
    // Anything unexpected is reported by kind only; the error text could carry a URL.
    outcome = { status: 'rpc-error', detail: 'unexpected' };
  }

  const end = deps.net.now();
  meta.lastStatus = describe(outcome);
  meta.lastRunAt = end;
  if (unhealthyRun(outcome)) meta.unhealthySince ??= now;
  else if (CLEARING.has(outcome.status)) meta.unhealthySince = null;

  const committed = await deps.state.commit(token, meta, end);
  if (!committed.ok) {
    outcome = { status: 'lease-lost' };
    meta.unhealthySince ??= now;
  }

  if (meta.unhealthySince !== null && end - meta.unhealthySince >= UNHEALTHY_REPORT_MS)
    await deps.ping('fail', `mako-rounds-keeper ${describe(outcome)}`);
  else if (!unhealthyRun(outcome)) await deps.ping('ok', describe(outcome));
  return outcome;
}

const rpcFailure = (kind: string): Outcome =>
  kind === 'rate_limited' ? { status: 'rpc-rate-limited' } : { status: 'rpc-error', detail: kind };

function itemFailure(item: RpcItem): Outcome {
  return item.ok ? { status: 'rpc-error', detail: 'bad_response' } : rpcFailure(item.kind);
}

async function rpc(cfg: RunConfig, deps: Deps, calls: RpcCall[]): Promise<RpcItem[] | Outcome> {
  const res = await rpcBatch(deps.net, cfg.rpcUrl, calls);
  if (!res.ok) return rpcFailure(res.kind);
  return res.items;
}

const isOutcome = (x: unknown): x is Outcome => typeof x === 'object' && x !== null && 'status' in x;

async function settleOne(cfg: RunConfig, deps: Deps, token: number, meta: Meta): Promise<Outcome> {
  const nowMs = deps.net.now();
  const call = (data: Hex): RpcCall => ({ method: 'eth_call', params: [{ to: cfg.roundsAddress, data }, 'latest'] });
  let prior: Outcome | undefined;

  // 1. The earlier transaction, first. Never a second one while it may still land.
  if (meta.inFlight) {
    const f = meta.inFlight;
    const items = await rpc(cfg, deps, [
      { method: 'eth_getTransactionReceipt', params: [f.hash] },
      { method: 'eth_getTransactionCount', params: [cfg.keeperAddress, 'latest'] },
    ]);
    if (isOutcome(items)) return items;
    const [receiptItem, nonceItem] = items;
    if (!receiptItem.ok) return itemFailure(receiptItem);
    const receipt = receiptItem.result as { status?: string } | null;
    if (receipt && typeof receipt === 'object') {
      meta.inFlight = null;
      if (receipt.status === '0x1') prior = { status: 'settled', detail: `round ${f.roundId} ${f.hash}` };
      else {
        meta.txFailures[f.roundId] = (meta.txFailures[f.roundId] ?? 0) + 1;
        prior = { status: 'tx-reverted', detail: `round ${f.roundId} ${f.hash}` };
      }
    }
    else {
    if (!nonceItem.ok) return itemFailure(nonceItem);
    const latestNonce = safeQuantity(nonceItem.result);
    if (latestNonce === null) return { status: 'rpc-error', detail: 'bad_nonce' };
    // No receipt yet. Within 3 minutes, wait: never send a second transaction while this one may still land.
    if (nowMs - f.sentAt < TX_STUCK_MS) return { status: 'tx-pending', detail: `round ${f.roundId} ${f.hash}` };
    // After 3 minutes with no receipt: if the nonce is still unused it was dropped (or never sent); if it was
    // used, another transaction took it. Either way this one will not land. Clear it and report it; the next
    // run re-simulates, so a round someone else settled meanwhile is not sent again.
    meta.inFlight = null;
    meta.txFailures[f.roundId] = (meta.txFailures[f.roundId] ?? 0) + 1;
    prior = { status: 'tx-dropped', detail: `round ${f.roundId} ${f.hash} nonce ${latestNonce > f.nonce ? 'used' : 'unused'}` };
    }
  }

  // Resolved or none: go on to this run's round (SPEC §5.5 step 1: every run takes one round), so a
  // receipt never costs a minute. At most 7 requests plus the ping (T0.1c: 10 per round).
  const next = await takeRound(cfg, deps, token, meta, nowMs, call);
  return prior ? { ...next, prior } : next;
}

async function takeRound(
  cfg: RunConfig,
  deps: Deps,
  token: number,
  meta: Meta,
  nowMs: number,
  call: (data: Hex) => RpcCall,
): Promise<Outcome> {

  // 2. What is due.
  const first = await rpc(cfg, deps, [call(pendingSettlementData()), call(durationData())]);
  if (isOutcome(first)) return first;
  const [pendingItem, durationItem] = first;
  if (!pendingItem.ok) return itemFailure(pendingItem);
  if (!durationItem.ok) return itemFailure(durationItem);
  let pending: readonly bigint[];
  let duration: bigint;
  try {
    pending = decodePending(pendingItem.result as Hex);
    duration = decodeDuration(durationItem.result as Hex);
  } catch {
    return { status: 'rpc-error', detail: 'bad_response' };
  }
  if (pending.length === 0) return { status: 'nothing-due' };

  const closes = await rpc(cfg, deps, pending.map((id) => call(closeTimeData(id))));
  if (isOutcome(closes)) return closes;
  const closeTimes = new Map<bigint, bigint>();
  for (let i = 0; i < pending.length; i++) {
    const it = closes[i];
    if (!it.ok) return itemFailure(it);
    try {
      closeTimes.set(pending[i], decodeCloseTime(it.result as Hex));
    } catch {
      return { status: 'rpc-error', detail: 'bad_response' };
    }
  }
  const nowS = Math.floor(nowMs / 1000);
  // Memory only for rounds still pending: a settled or refunded round leaves pendingSettlement.
  const live = new Set(pending.map(String));
  for (const k of Object.keys(meta.attempts)) if (!live.has(k)) delete meta.attempts[k];
  for (const k of Object.keys(meta.txFailures)) if (!live.has(k)) delete meta.txFailures[k];

  const alarms: string[] = [];
  const skip = new Set<bigint>();
  for (const id of pending) {
    const late = nowS - Number(closeTimes.get(id));
    if (late >= REPORT_MISSING_ALERT_S) alarms.push(`round ${id} unsettled ${Math.floor(late / 60)} min after close`);
    if ((meta.txFailures[String(id)] ?? 0) >= MAX_TX_FAILURES) {
      skip.add(id);
      alarms.push(`round ${id} not sent after ${MAX_TX_FAILURES} failed transactions`);
    }
  }
  const alarm = alarms.length ? alarms.join('; ') : undefined;
  const withAlarm = (o: Outcome): Outcome => (alarm ? { ...o, alarm } : o);

  const lastTried = new Map(Object.entries(meta.attempts).map(([k, v]) => [BigInt(k), v] as [bigint, number]));
  const due = pickRound(pending, closeTimes, duration, nowS, undefined, lastTried, skip);
  if (due === null) return withAlarm({ status: 'nothing-due' });
  meta.attempts[due.roundId.toString()] = nowMs;
  return withAlarm(await deliver(cfg, deps, token, meta, nowS, due));
}

async function deliver(cfg: RunConfig, deps: Deps, token: number, meta: Meta, nowS: number, due: Due): Promise<Outcome> {
  const round = `round ${due.roundId}`;

  // 3. Both reports.
  const reports: Hex[] = [];
  for (const boundary of [due.anchorAt, due.closeAt]) {
    const path = reportPath(boundary);
    const ts = String(deps.net.now());
    const headers = await reportHeaders(path, cfg.datastreamsKey, cfg.datastreamsSecret, ts, deps.hmac);
    const res = await send(deps.net, cfg.datastreamsUrl + path, { method: 'GET', headers });
    if (!res.ok && res.status === undefined) return { status: 'report-api-error', detail: `${round} ${res.kind}` };
    const status = res.ok ? res.status : (res.status as number);
    const text = res.ok ? res.text : (res.text ?? '');
    const r = readReport(status, text, res.headers?.get('x-request-id') ?? null, boundary);
    if (!r.ok) {
      if (r.reason === 'not_found') {
        const late = nowS - due.closeAt >= REPORT_MISSING_ALERT_S;
        return { status: late ? 'report-missing-30m' : 'waiting-report', detail: `${round} B=${boundary}` };
      }
      return { status: 'report-api-error', detail: `${round} ${r.reason} ${r.status}${r.requestId ? ` ${r.requestId}` : ''}` };
    }
    reports.push(r.fullReport);
  }

  // 4. Simulate, estimate, and read what sending needs, in one batch.
  const data = settleData(due.roundId, reports[0], reports[1]);
  const tx = { from: cfg.keeperAddress, to: cfg.roundsAddress, data };
  const batch = await rpc(cfg, deps, [
    { method: 'eth_call', params: [tx, 'latest'] },
    { method: 'eth_estimateGas', params: [tx, 'latest'] },
    { method: 'eth_getBlockByNumber', params: ['latest', false] },
    { method: 'eth_maxPriorityFeePerGas', params: [] },
    { method: 'eth_getBalance', params: [cfg.keeperAddress, 'latest'] },
    { method: 'eth_getTransactionCount', params: [cfg.keeperAddress, 'pending'] },
  ]);
  if (isOutcome(batch)) return batch;
  const [simItem, gasItem, blockItem, tipItem, balItem, nonceItem] = batch;
  if (!simItem.ok) {
    if (simItem.kind !== 'rpc_error') return rpcFailure(simItem.kind);
    const name = revertName(simItem.data);
    // Someone else, CRE or another courier, settled it first: the goal is met.
    if (name === 'RoundAlreadyTerminal') return { status: 'already-settled', detail: round };
    return { status: 'simulation-reverted', detail: `${round} ${name ?? 'unknown'}` };
  }
  for (const it of [gasItem, blockItem, tipItem, balItem, nonceItem]) if (!it.ok) return itemFailure(it);
  const estimate = hexQuantity((gasItem as { result: unknown }).result);
  const baseFee = hexQuantity(((blockItem as { result: unknown }).result as { baseFeePerGas?: unknown } | null)?.baseFeePerGas);
  const tip = hexQuantity((tipItem as { result: unknown }).result);
  const balance = hexQuantity((balItem as { result: unknown }).result);
  const nonce = safeQuantity((nonceItem as { result: unknown }).result);
  if (estimate === null || baseFee === null || tip === null || balance === null || nonce === null)
    return { status: 'rpc-error', detail: 'bad_response' };
  if (estimate > SETTLE_GAS_CEILING) return { status: 'gas-over-budget', detail: `${round} ${estimate}` };

  // Monad charges the gas LIMIT, so it stays tight: the estimate plus 20%, never above the ceiling.
  const gas = minBig((estimate * 12n) / 10n, SETTLE_GAS_CEILING);
  const maxPriorityFeePerGas = tip;
  const maxFeePerGas = baseFee * 2n + tip;
  const cost = gas * maxFeePerGas;
  if (balance < cost) return { status: 'low-gas-balance', detail: `${round} balance ${balance} < ${cost}` };
  const lowAfter = balance - cost < cost * LOW_BALANCE_SETTLEMENTS;

  if (cfg.dryRun) return { status: 'dry-run-would-send', detail: `${round} gas ${gas}` };

  // 5. Sign, record under the lease, then send.
  const raw = await deps.sign({ to: cfg.roundsAddress, data, nonce, gas, maxFeePerGas, maxPriorityFeePerGas });
  const hash = keccak256(raw);
  const inFlight: InFlight = { hash, nonce, roundId: due.roundId.toString(), sentAt: deps.net.now() };
  const recorded = await deps.state.recordInFlight(token, inFlight, deps.net.now());
  if (!recorded.ok) return { status: 'lease-lost', detail: round };
  meta.inFlight = inFlight;

  const sent = await rpcBatch(deps.net, cfg.rpcUrl, [{ method: 'eth_sendRawTransaction', params: [raw] }]);
  // A failed send leaves the recorded transaction; the next run finds no receipt and an unused nonce, and after
  // TX_STUCK_MS reports it dropped and tries again. A rejected send (e.g. a nonce race) is reported now.
  if (!sent.ok) return rpcFailure(sent.kind);
  if (!sent.items[0].ok) return itemFailure(sent.items[0]);
  return { status: lowAfter ? 'sent-low-gas' : 'sent', detail: `${round} ${hash}` };
}

const minBig = (a: bigint, b: bigint): bigint => (a < b ? a : b);
