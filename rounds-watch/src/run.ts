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
import { send, type HttpResult, type Net } from './net';
import { aggregate, decodeAggregate } from './multicall';
import { rpcBatch, type RpcCall } from './rpc';
import type { AlertKind, Evidence, Meta, PendingNoPrice } from './state';

/// N21: a round unsettled this long after close is flagged.
export const UNSETTLED_ALERT_S = 30 * 60;
/// New round ids read per run by the history scan. Rounds are created far more slowly than 40 per 5 minutes.
export const MAX_SCAN = 40;
/// Active round ids read per run. The contract caps non-terminal rounds at MAX_ACTIVE_ROUNDS (10), so all are
/// read every run; if the set were ever larger, reads rotate and nothing is dropped.
export const MAX_ACTIVE_READ = 40;
/// Report checks per run (2 Data Streams requests each). Checks rotate: rounds with no check yet go first,
/// then the oldest check, so every due round is checked within a bounded number of runs, Telegram or not.
export const MAX_CHECKS_PER_RUN = 4;
/// A report check this old is repeated, so an "unknown" or "missing" is not kept forever.
export const EVIDENCE_TTL_MS = 30 * 60_000;
/// Healthchecks stores the first 100,000 bytes of a ping body (healthchecks.io/docs/attaching_logs). The
/// failure body is built to fit: a capped condition summary, then a page of whole alert lines.
export const HC_BODY_BYTES = 100_000;
const HC_SUMMARY_BYTES = 10_000;

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
    /// Moves the Healthchecks page cursor from `from` to `next`, only if it is still at `from`.
    advanceHcCursor(from: number, next: number): Promise<{ ok: boolean }>;
  };
  hmac: HmacHex;
  /// Sends one Telegram message; true only if Telegram confirmed it.
  telegram(text: string): Promise<boolean>;
  /// Pings Healthchecks; true only if Healthchecks accepted the ping (HTTP 2xx and an "OK" body).
  ping(kind: 'ok' | 'fail', body: string): Promise<boolean>;
}

export type WatchStatus = 'quiet' | 'alerting' | 'telegram-failed' | 'rpc-error' | 'lease-held' | 'lease-lost';

export interface WatchOutcome {
  status: WatchStatus;
  /// The alert lines this run tried to deliver (secret-free).
  lines: string[];
  /// The alert lines for this run's Healthchecks failure body: a page that rotates across runs.
  hcPage?: string[];
  /// The saved cursor (a round id) this page started from, and the round id the next page would start at. The
  /// cursor moves to `hcNext` only after Healthchecks accepts a ping that carried the page, so a rejected or
  /// lost ping, or one sent without the page, repeats it (Codex T2.0d r4; adversary on 5ac8a70).
  hcFrom?: number;
  hcNext?: number;
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

/// Whether Healthchecks accepted a ping: HTTP 2xx with the body "OK". "OK (not found)" (an unknown check), a
/// timeout, a 429 or a 5xx is not acceptance, so the page cursor stays and the page is sent again.
export function healthchecksAccepted(res: HttpResult): boolean {
  return res.ok && res.text.trim() === 'OK';
}

export async function runWatch(cfg: WatchConfig, deps: WatchDeps): Promise<WatchOutcome> {
  const now = deps.net.now();
  const acquired = await deps.state.acquire(now);
  if (!acquired.ok) return { status: 'lease-held', lines: [], conditions: [] };
  // Earlier versions of this state kept `cursor` or `open`; their ids are re-read as active candidates, and
  // the chain decides what they are.
  const m = acquired.meta as Partial<Meta> & { cursor?: number; open?: number[] };
  const meta: Meta = {
    historyCursor: m.historyCursor ?? m.cursor ?? 1,
    active: [...new Set([...(m.active ?? []), ...(m.open ?? [])])],
    activeCursor: m.activeCursor ?? 0,
    noPrice: { ...(m.noPrice ?? {}) },
    alerted: { ...(m.alerted ?? {}) },
    evidence: { ...(m.evidence ?? {}) },
    hcCursor: m.hcCursor ?? 0,
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
    const accepted = await deps.ping('fail', failureBody(outcome));
    // The page cursor is a delivery cursor: it moves past a page only once Healthchecks has that page. The
    // move is a separate compare-and-set after the commit, so a second run that already moved it, or a
    // failure here, can only repeat a page, never skip one.
    // Only a ping that CARRIED the page can move past it: with Telegram working the body is the summary
    // alone, and moving then would skip lines no channel delivered (adversary on 5ac8a70).
    const carriedPage = outcome.status === 'telegram-failed' && (outcome.hcPage?.length ?? 0) > 0;
    if (
      accepted &&
      carriedPage &&
      outcome.hcFrom !== undefined &&
      outcome.hcNext !== undefined &&
      outcome.hcNext !== outcome.hcFrom
    ) {
      await deps.state.advanceHcCursor(outcome.hcFrom, outcome.hcNext);
    }
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

  // Two sources, so an old round can never hide a newer one (Codex T2.0d r1): every active round, and the
  // next new ids from the history cursor, which always moves forward. NoPrice alerts waiting for Telegram
  // are not re-read at all: a refunded round never changes (Codex T2.0d r2).
  const activeAll = [...new Set(meta.active)].sort((a, b) => a - b);
  let activeRead = activeAll;
  if (activeAll.length > MAX_ACTIVE_READ) {
    const from = meta.activeCursor % activeAll.length;
    activeRead = [...activeAll.slice(from), ...activeAll.slice(0, from)].slice(0, MAX_ACTIVE_READ);
    meta.activeCursor = (from + MAX_ACTIVE_READ) % activeAll.length;
  }
  const fresh: number[] = [];
  for (let id = Math.max(1, meta.historyCursor); id <= count && fresh.length < MAX_SCAN; id++) fresh.push(id);
  const ids = [...new Set([...activeRead, ...fresh])];

  const rounds: RoundView[] = [];
  if (ids.length > 0) {
    // ONE Multicall3 item for every read: the public Monad RPC refuses JSON-RPC items beyond 15 a second, so
    // a plain batch of up to 80 reads would fail most of them on every run (measured 2026-09-29). Every id
    // here exists (fresh ids stop at roundCount), so any failed read fails the run: reported, never skipped.
    const res = await rpcBatch(deps.net, cfg.rpcUrl, [
      aggregate(ids.map((id) => ({ target: cfg.roundsAddress, data: encodeFunctionData({ abi: WATCH_ABI, functionName: 'roundOf', args: [BigInt(id)] }) }))),
    ]);
    if (!res.ok || !res.items[0].ok) return { status: 'rpc-error', lines: [], conditions: [] };
    const results = decodeAggregate(res.items[0].result, ids.length);
    if (results === null) return { status: 'rpc-error', lines: [], conditions: [] };
    for (let i = 0; i < ids.length; i++) {
      if (!results[i].success) return { status: 'rpc-error', lines: [], conditions: [] };
      const r = decodeFunctionResult({ abi: WATCH_ABI, functionName: 'roundOf', args: [0n], data: results[i].returnData });
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

  // Classify what was read. Only ids actually read are moved: an active id not read this run stays active.
  const readIds = new Set(rounds.map((r) => r.id));
  const active = new Set(activeAll.filter((id) => !readIds.has(id)));
  for (const r of rounds) {
    if (r.status === STATUS.Active || r.status === STATUS.None) active.add(r.id);
    else if (r.status === STATUS.Refunded && r.refundReason === REFUND_REASON.NoPrice)
      meta.noPrice[String(r.id)] ??= { startTime: r.startTime, closeTime: r.closeTime };
  }
  meta.active = [...active].sort((a, b) => a - b);
  if (fresh.length) meta.historyCursor = fresh[fresh.length - 1] + 1;

  // What is in an alert condition now, and what has not been said yet.
  const conditions: string[] = [];
  const due: { round: RoundView; kind: AlertKind }[] = [];
  for (const r of rounds) {
    if (r.status === STATUS.Active && r.twoSided && nowS - r.closeTime >= UNSETTLED_ALERT_S) {
      conditions.push(`round ${r.id} unsettled ${Math.floor((nowS - r.closeTime) / 60)} min after close`);
      if (meta.alerted[String(r.id)]?.unsettled === undefined) due.push({ round: r, kind: 'unsettled' });
    }
  }
  for (const [k, p] of Object.entries(meta.noPrice).sort(([a], [b]) => Number(a) - Number(b))) {
    conditions.push(`round ${k} refunded NoPrice`);
    due.push({ round: noPriceView(Number(k), p), kind: 'no-price' });
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
  let text = 'Mako rounds watch';
  let included = 0;
  for (const l of lines) {
    if (text.length + 2 + l.length > TELEGRAM_CHARS) break;
    text += '\n\n' + l;
    included++;
  }
  if (included > 0) {
    const ok = await deps.telegram(text);
    if (ok) {
      for (const { round, kind } of ready.slice(0, included)) {
        if (kind === 'no-price') delete meta.noPrice[String(round.id)];
        else meta.alerted[String(round.id)] = { ...(meta.alerted[String(round.id)] ?? {}), unsettled: nowMs };
      }
    } else {
      status = 'telegram-failed';
    }
  }

  // The Healthchecks page: whole lines in round-id order, starting at the first round id at or after the saved
  // cursor, wrapping, as many as fit. The cursor is a ROUND ID, not a position, so rounds settling or new
  // alerts arriving between runs cannot shift it past a line (adversary on 5ac8a70). It is NOT moved here:
  // runWatch moves it only after Healthchecks accepts a ping that carried this page.
  const pageBudget = HC_BODY_BYTES - HC_SUMMARY_BYTES - 200;
  const hcPage: string[] = [];
  let hcFrom: number | undefined;
  let hcNext: number | undefined;
  if (lines.length > 0) {
    const byId = ready.map((r, i) => ({ id: r.round.id, line: lines[i] })).sort((a, b) => a.id - b.id);
    const startAt = byId.findIndex((x) => x.id >= meta.hcCursor);
    const from = startAt === -1 ? 0 : startAt;
    let used = 0;
    let lastId = -1;
    for (let i = 0; i < byId.length; i++) {
      const { id, line } = byId[(from + i) % byId.length];
      const size = bytes(line) + 1;
      if (used + size > pageBudget) break;
      hcPage.push(line);
      used += size;
      lastId = id;
    }
    hcFrom = meta.hcCursor;
    // The next page starts after the last round on this one; past the highest id it wraps to the lowest.
    hcNext = lastId === -1 ? meta.hcCursor : lastId + 1;
  }

  // Forget alert and evidence records only for rounds that are neither active nor waiting on a NoPrice alert.
  const keep = new Set([...meta.active.map(String), ...Object.keys(meta.noPrice)]);
  for (const k of Object.keys(meta.alerted)) if (!keep.has(k)) delete meta.alerted[k];
  for (const k of Object.keys(meta.evidence)) if (!keep.has(k)) delete meta.evidence[k];

  return { status, lines, conditions, hcPage, hcFrom, hcNext };
}

const noPriceView = (id: number, p: PendingNoPrice): RoundView => ({
  id,
  status: STATUS.Refunded,
  refundReason: REFUND_REASON.NoPrice,
  startTime: p.startTime,
  closeTime: p.closeTime,
  twoSided: true,
});

const bytes = (s: string): number => new TextEncoder().encode(s).length;

/// The Healthchecks failure body, always within HC_BODY_BYTES: a capped summary of every condition, then,
/// if Telegram failed, this run's page of full alert lines and which part of the whole it is.
export function failureBody(o: WatchOutcome): string {
  const out = ['mako-rounds-watch'];
  let used = bytes(out[0]) + 1;
  let shown = 0;
  for (const c of o.conditions) {
    if (used + bytes(c) + 1 > HC_SUMMARY_BYTES - 100) break;
    out.push(c);
    used += bytes(c) + 1;
    shown++;
  }
  if (shown < o.conditions.length) out.push(`+${o.conditions.length - shown} more conditions`);
  if (o.status === 'telegram-failed') {
    const page = o.hcPage ?? [];
    out.push(`TELEGRAM DELIVERY FAILED: ${page.length} of ${o.lines.length} alert lines in this ping; the rest rotate into the next pings.`);
    out.push(...page);
  }
  return out.join('\n');
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
    // Only what the API said (Codex T2.0d r5): reports existing does not mean they verify on chain or that the
    // round can settle (a fee manager or a changed verifier configuration would stop it), and this watch checks
    // neither.
    cause = 'The API returned reports for both seconds. This watch did not verify them on chain or try to settle. Check the keeper and CRE first, then the verifier: a fee manager or a changed signing configuration would also stop settlement, and the round then refunds NoPrice at its deadline.';
  else if (e.start === 'missing' || e.close === 'missing')
    cause = 'A report is missing for that second; if it never appears, the round cannot settle and refunds NoPrice at its deadline.';
  else cause = 'Report availability could not be checked; the next check repeats it.';
  return `Round ${r.id} is UNSETTLED ${Math.floor((nowS - r.closeTime) / 60)} min after close. ${reports} ${cause}`;
}
