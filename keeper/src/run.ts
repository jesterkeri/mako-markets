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
import { decodeErrorResult, decodeFunctionResult, encodeFunctionData, type Abi } from 'viem';
import { POOLS_ABI, ROUND_STATUS, ROUNDS_REFUND_ABI } from './abi-refunds';
import { aggregate, decodeAggregate } from './multicall';
import type { InFlight, Meta, TxKind } from './state';

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
/// Circuit breaker on automatic V4 refunds (Joshua 2026-09-29, after the 2026-06-12 wrongful NBA refunds).
export const POOL_REFUNDS_PER_HOUR = 3;
export const POOL_REFUNDS_PER_DAY = 6;
/// Ids read per run by each discovery scan, and open ids re-read per run (rotating past this, dropping none).
export const DISCOVERY_FRESH = 20;
export const DISCOVERY_OPEN = 30;

export type Healthy =
  | 'settled'
  | 'round-refunded'
  | 'pool-refunded'
  | 'already-refunded'
  | 'already-resolved'
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
  /// A transaction with no receipt after 3 minutes that may still land: kept, nothing new sent (Codex T2.0 r1).
  | 'tx-stuck'
  | 'refund-breaker-tripped'
  | 'lease-lost';
export type Status = Healthy | Unhealthy;

/// Statuses that show the keeper working, and so end an unhealthy stretch. `sent`, `tx-pending` and
/// `lease-held` are neutral: they neither start nor end one, so a transaction that reverts every time
/// (sent, reverted, sent, ...) still reaches Healthchecks (adversary pass, 2026-09-28).
const CLEARING = new Set<Status>([
  'settled',
  'round-refunded',
  'pool-refunded',
  'nothing-due',
  'dry-run-would-send',
  'waiting-report',
  'already-settled',
  'already-refunded',
  'already-resolved',
]);

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
  'tx-stuck',
  'refund-breaker-tripped',
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
  /// Live MakoMarketsV4 (Pools): overdue markets are refunded automatically.
  poolsAddress: Hex;
  /// REFUND_BREAKER_RESET (ms): a tripped breaker clears when this is later than the trip.
  breakerResetAt: number | null;
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
  recordInFlight(token: number, inFlight: InFlight, now: number, extra?: Partial<Meta>): Promise<{ ok: boolean }>;
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
  const a = acquired.meta as Partial<Meta>;
  const meta: Meta = {
    ...acquired.meta,
    attempts: { ...(a.attempts ?? {}) },
    txFailures: { ...(a.txFailures ?? {}) },
    roundsCursor: a.roundsCursor ?? 1,
    roundsOpen: [...(a.roundsOpen ?? [])],
    poolsCursor: a.poolsCursor ?? 0,
    poolsOpen: [...(a.poolsOpen ?? [])],
    poolRefundsSent: [...(a.poolRefundsSent ?? [])],
    breakerTrippedAt: a.breakerTrippedAt ?? null,
  };

  // The breaker's reset is Joshua's: REFUND_BREAKER_RESET clears a trip only if it is later than the trip AND
  // not in the future. A future reset would otherwise clear every trip until that time, which is no breaker
  // at all (adversary pass, 2026-09-29).
  const resetFuture = cfg.breakerResetAt !== null && cfg.breakerResetAt > now;
  if (meta.breakerTrippedAt !== null && cfg.breakerResetAt !== null && !resetFuture && cfg.breakerResetAt > meta.breakerTrippedAt) {
    meta.breakerTrippedAt = null;
    meta.poolRefundsSent = [];
  }

  let outcome: Outcome;
  try {
    outcome = await settleOne(cfg, deps, token, meta);
  } catch {
    // Anything unexpected is reported by kind only; the error text could carry a URL.
    outcome = { status: 'rpc-error', detail: 'unexpected' };
  }
  // A tripped breaker is an alarm on EVERY run until reset, busy or idle.
  if (meta.breakerTrippedAt !== null)
    outcome = withAlarms(outcome, [
      `automatic pool refunds HALTED by the breaker since ${iso(meta.breakerTrippedAt)}; set REFUND_BREAKER_RESET to a time after that and no later than now to resume` +
        (resetFuture ? ' (the REFUND_BREAKER_RESET set now is in the future, so it is ignored)' : ''),
    ]);

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
    await deps.ping('fail', `mako-settlement-keeper ${describe(outcome)}`);
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
  /// Set when the earlier transaction is provably gone from the node: the next send must reuse its nonce, so the
  /// old one and the new one can never both execute (Codex T2.0 r1).
  let replaceNonce: number | undefined;
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
    const label = targetLabel(f.kind ?? 'settle', f.roundId);
    if (receipt && typeof receipt === 'object') {
      meta.inFlight = null;
      const kind = f.kind ?? 'settle';
      if (receipt.status === '0x1') prior = { status: LANDED[kind], detail: `${targetLabel(kind, f.roundId)} ${f.hash}` };
      else {
        meta.txFailures[failKey(kind, f.roundId)] = (meta.txFailures[failKey(kind, f.roundId)] ?? 0) + 1;
        prior = { status: 'tx-reverted', detail: `${targetLabel(kind, f.roundId)} ${f.hash}` };
      }
    } else {
      if (!nonceItem.ok) return itemFailure(nonceItem);
      const latestNonce = safeQuantity(nonceItem.result);
      if (latestNonce === null) return { status: 'rpc-error', detail: 'bad_nonce' };
      // No receipt yet. Within 3 minutes, wait: never send a second transaction while this one may still land.
      if (nowMs - f.sentAt < TX_STUCK_MS) return { status: 'tx-pending', detail: `${label} ${f.hash}` };
      const fk = failKey(f.kind ?? 'settle', f.roundId);
      if (latestNonce > f.nonce) {
        // Its nonce is used on chain and it has no receipt: another transaction took the nonce, so this one can
        // never land. Clear it; the next run re-simulates, so a round settled meanwhile is not sent again.
        meta.inFlight = null;
        meta.txFailures[fk] = (meta.txFailures[fk] ?? 0) + 1;
        prior = { status: 'tx-dropped', detail: `${label} ${f.hash} nonce used` };
      } else {
        // The nonce is unused. A null receipt does not mean dropped: the node may hold it, unmined. Ask.
        const more = await rpc(cfg, deps, [
          { method: 'eth_getTransactionByHash', params: [f.hash] },
          { method: 'eth_getTransactionCount', params: [cfg.keeperAddress, 'pending'] },
        ]);
        if (isOutcome(more)) return more;
        const [byHash, pendingItem] = more;
        if (!byHash.ok) return itemFailure(byHash);
        if (!pendingItem.ok) return itemFailure(pendingItem);
        const pendingNonce = safeQuantity(pendingItem.result);
        if (pendingNonce === null) return { status: 'rpc-error', detail: 'bad_nonce' };
        const known = byHash.result !== null && byHash.result !== undefined;
        if (known || pendingNonce > f.nonce) {
          // It may still land: keep it, send nothing, and say so every run until it resolves.
          return { status: 'tx-stuck', detail: `${label} ${f.hash} nonce ${f.nonce} ${known ? 'still known to the node' : 'pending'}` };
        }
        // Unknown to the node and its nonce unused: replace it at the SAME nonce, so at most one of the two can
        // ever execute. The send below refuses if the nonce has moved by then.
        meta.inFlight = null;
        meta.txFailures[fk] = (meta.txFailures[fk] ?? 0) + 1;
        replaceNonce = f.nonce;
        prior = { status: 'tx-dropped', detail: `${label} ${f.hash} unknown to the node; any resend reuses nonce ${f.nonce}` };
      }
    }
  }

  // Resolved or none: go on to this run's round (SPEC §5.5 step 1: every run takes one round), so a
  // receipt never costs a minute. At most 7 requests plus the ping (T0.1c: 10 per round).
  meta.replaceNonce = replaceNonce;
  try {
    const next = await takeRound(cfg, deps, token, meta, nowMs, call);
    return prior ? { ...next, prior } : next;
  } finally {
    delete meta.replaceNonce;
  }
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
  // Nothing to settle: this run's transaction, if any, is an overdue refund.
  if (pending.length === 0) return takeRefund(cfg, deps, token, meta, nowMs);

  // One Multicall3 item for every close time: the public RPC limits items per second, not requests.
  const closes = await rpc(cfg, deps, [aggregate(pending.map((id) => ({ target: cfg.roundsAddress, data: closeTimeData(id) })))]);
  if (isOutcome(closes)) return closes;
  if (!closes[0].ok) return itemFailure(closes[0]);
  const closeResults = decodeAggregate(closes[0].result, pending.length);
  if (closeResults === null) return { status: 'rpc-error', detail: 'bad_response' };
  const closeTimes = new Map<bigint, bigint>();
  for (let i = 0; i < pending.length; i++) {
    if (!closeResults[i].success) return { status: 'rpc-error', detail: `closeTimeOf ${pending[i]} failed` };
    try {
      closeTimes.set(pending[i], decodeCloseTime(closeResults[i].returnData));
    } catch {
      return { status: 'rpc-error', detail: 'bad_response' };
    }
  }
  const nowS = Math.floor(nowMs / 1000);
  // Memory only for rounds still pending: a settled or refunded round leaves pendingSettlement.
  // Settlement keys are bare round ids; refund keys carry a prefix and are pruned by the refund scan.
  const live = new Set(pending.map(String));
  for (const k of Object.keys(meta.attempts)) if (/^\d+$/.test(k) && !live.has(k)) delete meta.attempts[k];
  for (const k of Object.keys(meta.txFailures)) if (/^\d+$/.test(k) && !live.has(k)) delete meta.txFailures[k];

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

  const lastTried = new Map(
    Object.entries(meta.attempts)
      .filter(([k]) => /^\d+$/.test(k))
      .map(([k, v]) => [BigInt(k), v] as [bigint, number]),
  );
  const due = pickRound(pending, closeTimes, duration, nowS, undefined, lastTried, skip);
  if (due === null) return withAlarm(await takeRefund(cfg, deps, token, meta, nowMs));
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

  return sendTx(cfg, deps, token, meta, {
    kind: 'settle',
    to: cfg.roundsAddress,
    data: settleData(due.roundId, reports[0], reports[1]),
    target: due.roundId.toString(),
    decode: revertName,
    // Someone else, CRE or another courier, settled it first: the goal is met.
    done: { RoundAlreadyTerminal: 'already-settled' },
  });
}

const minBig = (a: bigint, b: bigint): bigint => (a < b ? a : b);

// ---------------------------------------------------------------------------------------------------------
// One transaction, whatever it does: simulate and estimate first, then sign, record under the lease, send.
// ---------------------------------------------------------------------------------------------------------

const LANDED: Record<TxKind, Status> = { settle: 'settled', 'round-refund': 'round-refunded', 'pool-refund': 'pool-refunded' };

function targetLabel(kind: TxKind, id: string): string {
  return kind === 'settle' ? `round ${id}` : kind === 'round-refund' ? `round ${id} refund` : `pool ${id} refund`;
}

/// txFailures and attempts keys: settlements use the bare round id, refunds a prefix.
function failKey(kind: TxKind, id: string): string {
  return kind === 'settle' ? id : kind === 'round-refund' ? `rr:${id}` : `pr:${id}`;
}

interface Job {
  kind: TxKind;
  to: Hex;
  data: Hex;
  target: string;
  /// Names a simulated revert from the target contract's errors.
  decode: (data: unknown) => string | null;
  /// Reverts that mean the goal is already met, and the healthy status to report instead.
  done: Record<string, Status>;
  /// Counts toward the breaker: the send time is written together with the in-flight record, before sending.
  countPoolRefund?: boolean;
}

async function sendTx(cfg: RunConfig, deps: Deps, token: number, meta: Meta, job: Job): Promise<Outcome> {
  const label = targetLabel(job.kind, job.target);
  const tx = { from: cfg.keeperAddress, to: job.to, data: job.data };
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
    const name = job.decode(simItem.data);
    if (name !== null && job.done[name]) return { status: job.done[name], detail: label };
    return { status: 'simulation-reverted', detail: `${label} ${name ?? 'unknown'}` };
  }
  for (const it of [gasItem, blockItem, tipItem, balItem, nonceItem]) if (!it.ok) return itemFailure(it);
  const estimate = hexQuantity((gasItem as { result: unknown }).result);
  const baseFee = hexQuantity(((blockItem as { result: unknown }).result as { baseFeePerGas?: unknown } | null)?.baseFeePerGas);
  const tip = hexQuantity((tipItem as { result: unknown }).result);
  const balance = hexQuantity((balItem as { result: unknown }).result);
  const nonce = safeQuantity((nonceItem as { result: unknown }).result);
  if (estimate === null || baseFee === null || tip === null || balance === null || nonce === null)
    return { status: 'rpc-error', detail: 'bad_response' };
  if (estimate > SETTLE_GAS_CEILING) return { status: 'gas-over-budget', detail: `${label} ${estimate}` };

  // Monad charges the gas LIMIT, so it stays tight: the estimate plus 20%, never above the ceiling.
  const gas = minBig((estimate * 12n) / 10n, SETTLE_GAS_CEILING);
  const maxPriorityFeePerGas = tip;
  const maxFeePerGas = baseFee * 2n + tip;
  const cost = gas * maxFeePerGas;
  if (balance < cost) return { status: 'low-gas-balance', detail: `${label} balance ${balance} < ${cost}` };
  const lowAfter = balance - cost < cost * LOW_BALANCE_SETTLEMENTS;

  if (cfg.dryRun) return { status: 'dry-run-would-send', detail: `${label} gas ${gas}` };
  // Replacing a transaction the node lost: only at its nonce, or not at all (Codex T2.0 r1).
  if (meta.replaceNonce !== undefined && nonce !== meta.replaceNonce) {
    return { status: 'tx-stuck', detail: `${label} replacement needs nonce ${meta.replaceNonce}, pending is ${nonce}; nothing sent` };
  }

  const raw = await deps.sign({ to: job.to, data: job.data, nonce, gas, maxFeePerGas, maxPriorityFeePerGas });
  const hash = keccak256(raw);
  const sentAt = deps.net.now();
  const inFlight: InFlight = { hash, nonce, roundId: job.target, sentAt, kind: job.kind };
  const extra: Partial<Meta> = job.countPoolRefund ? { poolRefundsSent: [...meta.poolRefundsSent, sentAt] } : {};
  const recorded = await deps.state.recordInFlight(token, inFlight, sentAt, extra);
  if (!recorded.ok) return { status: 'lease-lost', detail: label };
  meta.inFlight = inFlight;
  Object.assign(meta, extra);

  const sent = await rpcBatch(deps.net, cfg.rpcUrl, [{ method: 'eth_sendRawTransaction', params: [raw] }]);
  // A failed send leaves the recorded transaction; the next run finds no receipt and an unused nonce, and after
  // TX_STUCK_MS reports it dropped and tries again. A rejected send (e.g. a nonce race) is reported now.
  if (!sent.ok) return rpcFailure(sent.kind);
  if (!sent.items[0].ok) return itemFailure(sent.items[0]);
  return { status: lowAfter ? 'sent-low-gas' : 'sent', detail: `${label} ${hash}` };
}

// ---------------------------------------------------------------------------------------------------------
// Overdue refunds (Joshua 2026-09-29): "After a market closes, Mako has 24 hours to settle it correctly. If
// it is still unresolved after that, it refunds everyone." Both contracts make the refund permissionless and
// final, and payouts stay pull: this only moves the market to its refund; each person claims their own.
// ---------------------------------------------------------------------------------------------------------

const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');

function decodeWith(abi: Abi, data: unknown): string | null {
  if (typeof data !== 'string' || !/^0x[0-9a-fA-F]{8,}$/.test(data)) return null;
  try {
    return decodeErrorResult({ abi, data: data as Hex }).errorName;
  } catch {
    return null;
  }
}

/// Open ids re-read this run: all of them, or a rotating window if there are more than DISCOVERY_OPEN.
function openWindow(open: number[], nowS: number): number[] {
  const ids = [...new Set(open)].sort((a, b) => a - b);
  if (ids.length <= DISCOVERY_OPEN) return ids;
  const from = (Math.floor(nowS / 60) * DISCOVERY_OPEN) % ids.length;
  return [...ids.slice(from), ...ids.slice(0, from)].slice(0, DISCOVERY_OPEN);
}

interface Scan<T> {
  read: Map<number, T>;
  count: number;
  constants: bigint[];
}

/// One contract's discovery reads, for a Multicall3 item: its id counter, its constants, then each id. The
/// decoder is strict: a failed counter or constant, or a failed read of an id that exists, fails the run
/// (reported, never skipped); only an id past the end may fail, and it is simply not read yet. The first
/// version skipped any failed item, so a rate-limited read of a due market passed as "nothing due" forever
/// (adversary pass, 2026-09-29).
function scanReads<T>(
  to: Hex,
  abi: Abi,
  countFn: string,
  constants: string[],
  itemFn: string,
  ids: number[],
  exists: (id: number, count: number) => boolean,
) {
  const enc = (functionName: string, args: unknown[] = []) => encodeFunctionData({ abi, functionName, args } as never);
  const reads = [enc(countFn), ...constants.map((c) => enc(c)), ...ids.map((id) => enc(itemFn, [BigInt(id)]))].map((data) => ({ target: to, data }));
  const decode = (item: RpcItem): Scan<T> | Outcome => {
    if (!item.ok) return itemFailure(item);
    const results = decodeAggregate(item.result, reads.length);
    if (results === null) return { status: 'rpc-error', detail: 'bad_response' };
    const dec = (fn: string, data: Hex) => decodeFunctionResult({ abi, functionName: fn, data } as never) as unknown;
    const head = results.slice(0, 1 + constants.length);
    if (head.some((r) => !r.success)) return { status: 'rpc-error', detail: `${countFn} scan failed` };
    let count: number;
    let consts: bigint[];
    try {
      count = Number(dec(countFn, head[0].returnData) as bigint);
      consts = constants.map((c, i) => BigInt(dec(c, head[1 + i].returnData) as bigint));
    } catch {
      return { status: 'rpc-error', detail: 'bad_response' };
    }
    const read = new Map<number, T>();
    for (let i = 0; i < ids.length; i++) {
      const r = results[1 + constants.length + i];
      if (!exists(ids[i], count)) continue;
      if (!r.success) return { status: 'rpc-error', detail: `${itemFn} ${ids[i]} failed` };
      try {
        read.set(ids[i], dec(itemFn, r.returnData) as T);
      } catch {
        return { status: 'rpc-error', detail: 'bad_response' };
      }
    }
    return { read, count, constants: consts };
  };
  return { reads, decode };
}

interface RoundRow {
  startTime: bigint;
  status: number;
  upPool: bigint;
  downPool: bigint;
}
interface MarketRow {
  closeTime: bigint;
  resolved: boolean;
}

async function takeRefund(cfg: RunConfig, deps: Deps, token: number, meta: Meta, nowMs: number): Promise<Outcome> {
  const nowS = Math.floor(nowMs / 1000);
  meta.poolRefundsSent = meta.poolRefundsSent.filter((t) => nowMs - t <= 86_400_000);
  const alarms: string[] = [];

  // Discovery: for each contract, the open ids plus the next new ids, each contract as ONE Multicall3 item,
  // both in one request. Round ids run 1..roundCount; V4 market ids 0..nextMarketId-1.
  const roundIds = [...new Set([...openWindow(meta.roundsOpen, nowS), ...range(meta.roundsCursor, DISCOVERY_FRESH)])];
  const poolIds = [...new Set([...openWindow(meta.poolsOpen, nowS), ...range(meta.poolsCursor, DISCOVERY_FRESH)])];
  const rs = scanReads<RoundRow>(cfg.roundsAddress, ROUNDS_REFUND_ABI as Abi, 'roundCount', ['DURATION', 'SUBMIT_WINDOW', 'ENTRY_LEAD'], 'roundOf', roundIds, (id, n) => id >= 1 && id <= n);
  const ps = scanReads<MarketRow>(cfg.poolsAddress, POOLS_ABI as Abi, 'nextMarketId', ['RESOLUTION_GRACE'], 'getMarket', poolIds, (id, n) => id >= 0 && id < n);
  const items = await rpc(cfg, deps, [aggregate(rs.reads), aggregate(ps.reads)]);
  if (isOutcome(items)) return withAlarms(items, alarms);
  const r = rs.decode(items[0]);
  if (isOutcome(r)) return withAlarms(r, alarms);
  const p = ps.decode(items[1]);
  if (isOutcome(p)) return withAlarms(p, alarms);
  const [duration, submitWindow, entryLead] = r.constants;
  const roundsDue: number[] = [];
  const roundsOpen = new Set(meta.roundsOpen.filter((id) => !r.read.has(id)));
  for (const [id, row] of r.read) {
    if (Number(row.status) !== ROUND_STATUS.Active) continue;
    roundsOpen.add(id);
    const start = row.startTime;
    const oneSided = row.upPool === 0n || row.downPool === 0n;
    if ((BigInt(nowS) >= start - entryLead && oneSided) || BigInt(nowS) >= start + duration + submitWindow) roundsDue.push(id);
  }
  meta.roundsOpen = [...roundsOpen].sort((a, b) => a - b);
  meta.roundsCursor = advance(meta.roundsCursor, r.count, r.read, 1);

  // Pools (V4): the same, over unresolved markets.
  const [grace] = p.constants;
  const poolsDue: number[] = [];
  const poolsOpen = new Set(meta.poolsOpen.filter((id) => !p.read.has(id)));
  for (const [id, m] of p.read) {
    if (m.closeTime === 0n || m.resolved) continue;
    poolsOpen.add(id);
    if (BigInt(nowS) >= m.closeTime + grace) poolsDue.push(id);
  }
  meta.poolsOpen = [...poolsOpen].sort((a, b) => a - b);
  meta.poolsCursor = advance(meta.poolsCursor, p.count - 1, p.read, 0);

  // Forget refund memory for ids no longer open.
  const keep = new Set([...meta.roundsOpen.map((id) => `rr:${id}`), ...meta.poolsOpen.map((id) => `pr:${id}`)]);
  for (const k of Object.keys(meta.txFailures)) if (/^(rr|pr):/.test(k) && !keep.has(k)) delete meta.txFailures[k];
  for (const k of Object.keys(meta.attempts)) if (/^(rr|pr):/.test(k) && !keep.has(k)) delete meta.attempts[k];

  const skipped = (key: string) => (meta.txFailures[key] ?? 0) >= MAX_TX_FAILURES;
  for (const id of roundsDue) if (skipped(`rr:${id}`)) alarms.push(`round ${id} refund not sent after ${MAX_TX_FAILURES} failed transactions`);
  for (const id of poolsDue) if (skipped(`pr:${id}`)) alarms.push(`pool ${id} refund not sent after ${MAX_TX_FAILURES} failed transactions`);
  const next = (ids: number[], prefix: string) =>
    ids
      .filter((id) => !skipped(`${prefix}${id}`))
      .sort((a, b) => (meta.attempts[`${prefix}${a}`] ?? -1) - (meta.attempts[`${prefix}${b}`] ?? -1) || a - b)[0];

  // Rounds first: the contract derives the reason itself (OneSided or NoPrice), so no breaker is needed.
  const round = next(roundsDue, 'rr:');
  if (round !== undefined) {
    meta.attempts[`rr:${round}`] = nowMs;
    const o = await sendTx(cfg, deps, token, meta, {
      kind: 'round-refund',
      to: cfg.roundsAddress,
      data: encodeFunctionData({ abi: ROUNDS_REFUND_ABI, functionName: 'finalizeRefund', args: [BigInt(round)] }),
      target: String(round),
      decode: (d) => decodeWith(ROUNDS_REFUND_ABI as Abi, d) ?? revertName(d),
      done: { RoundAlreadyTerminal: 'already-refunded' },
    });
    return withAlarms(o, alarms);
  }

  const pool = next(poolsDue, 'pr:');
  if (pool === undefined || meta.breakerTrippedAt !== null) return withAlarms({ status: 'nothing-due' }, alarms);

  // The breaker: 3 automatic V4 refunds per hour, 6 per day. The next one past that trips it and halts them.
  // Closed windows: a refund exactly an hour (or a day) ago still counts.
  const lastHour = meta.poolRefundsSent.filter((t) => nowMs - t <= 3_600_000).length;
  if (lastHour >= POOL_REFUNDS_PER_HOUR || meta.poolRefundsSent.length >= POOL_REFUNDS_PER_DAY) {
    meta.breakerTrippedAt = nowMs;
    return withAlarms({ status: 'refund-breaker-tripped', detail: `${lastHour} this hour, ${meta.poolRefundsSent.length} today; ${poolsDue.length} due` }, alarms);
  }
  meta.attempts[`pr:${pool}`] = nowMs;
  const o = await sendTx(cfg, deps, token, meta, {
    kind: 'pool-refund',
    to: cfg.poolsAddress,
    data: encodeFunctionData({ abi: POOLS_ABI, functionName: 'forceRefund', args: [BigInt(pool)] }),
    target: String(pool),
    decode: (d) => decodeWith(POOLS_ABI as Abi, d),
    // The resolver settled it first: final either way, and the goal is met.
    done: { AlreadyResolved: 'already-resolved' },
    countPoolRefund: true,
  });
  return withAlarms(o, alarms);
}

function range(from: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => from + i);
}

/// The next id not yet read: past every consecutive id from `cursor` that was read and exists.
function advance<T>(cursor: number, lastId: number, read: Map<number, T>, first: number): number {
  let c = Math.max(first, cursor);
  while (c <= lastId && read.has(c)) c++;
  return c;
}

function withAlarms(o: Outcome, alarms: string[]): Outcome {
  if (alarms.length === 0) return o;
  return { ...o, alarm: o.alarm ? `${o.alarm}; ${alarms.join('; ')}` : alarms.join('; ') };
}
