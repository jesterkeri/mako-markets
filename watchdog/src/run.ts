// One watchdog run (r15 §5.1, slice 1). Every side effect goes through
// `deps`, so tests drive whole runs with a fake network, clock and state.
//
// Order: acquire -> provider-B discovery and pages (with the resolver RPC and
// due probes in parallel) -> discovery diff -> classify -> build alerts ->
// Telegram -> commit -> Healthchecks.

import { manifestLine, packCriticals, packNonCritical, pingHealthchecks, refundCommand, sendTelegram, type PingKind } from './alerts';
import { applyFlap, classifyStuck, commandAllowed, creationFindings, fmtUsdc, unsupportedOracle } from './classify';
import {
  DIGEST_HOUR_UTC,
  ENVELOPE_N,
  MAX_PARALLEL,
  ENVELOPE_N as BOOTSTRAP_MAX_IDS,
  NONCRITICAL_MAX_WAIT_MS,
  REMINDER_MS,
  RESOLVER_BALANCE_WARN_WEI,
  RUN_DEADLINE_MS,
} from './config';
import type { MarketHead } from './abi';
import { MARKET_TYPE } from './assets';
import { applyDiscovery, bitsFromHex, bitsToHex, formatRanges, transitionCandidates } from './discovery';
import { inGroups, makeNet } from './net';
import { dueProbes, probeCharts, probeComments, probeMarketPage, probeProviderB, probeResolverRpc, readPublicRpc, type ProbeResult } from './probes';
import { advanceCursor, compareHeads, confirmAtBlock, discover, planScan, readPages, readPublicAtBlock, type Confirmation, type DiscoveryResult, type PageOutcome, type PublicRead, type ScanPlan } from './scan';
import type { AcquireResult, CommitPayload, CommitResult, CriticalRow, NoteRow, WarningRow } from './state';

/// HTTP requests an ordinary slice-1 run may make: provider B 11, resolver
/// RPC 2 (the rr probe and one second-source confirmation), probes 3,
/// Telegram 4, Healthchecks 1 = 21. With the two Durable Object calls a run
/// stays within the plan's 24.
export const MAX_HTTP_REQUESTS = 22;
/// The bootstrap run (review r3) reads every id below N from the public RPC
/// at the snapshot block, up to 10 requests instead of 1: 30 HTTP + 2 Durable
/// Object = 32, still below r15's worst case of 48 and the 100 cap.
export const BOOTSTRAP_PUBLIC_REQUESTS = 10;
export const MAX_HTTP_REQUESTS_BOOTSTRAP = 30; // provider B 11, rr 1, public snapshot reads 10, probes 3, Telegram 4, Healthchecks 1

export interface RunEnv {
  makoAddress: string;
  resolverAddress: string;
  publicRpcUrl: string;
  appUrl: string;
  providerBUrl: string;
  telegramToken: string;
  telegramChatId: string;
  healthchecksUrl: string;
  dryRun: boolean;
}

export interface StateStub {
  acquire(scheduledTime: number, nowMs: number): Promise<AcquireResult>;
  commit(token: number, scheduledTime: number, payload: CommitPayload): Promise<CommitResult>;
}

export interface Deps {
  fetch: typeof fetch;
  now(): number;
  sleep(ms: number): Promise<void>;
  state: StateStub;
  env: RunEnv;
  log(line: string): void;
}

export interface RunReport {
  kind: 'skipped' | 'state_unavailable' | 'deadline' | 'completed';
  reason: string;
  effective: boolean;
  failed: string[];
  ping: PingKind | null;
  pingAccepted: boolean;
  httpRequests: number;
  doCalls: number;
  telegramMessages: string[];
  telegramConfirmed: boolean[];
  committed: boolean;
  payload: CommitPayload | null;
  plan: ScanPlan | null;
  healthchecksBody: string;
  s3Reasons: string[];
}

const PROBE_UNCLASSIFIED = /: (deadline|budget)$/;

export async function runOnce(deps: Deps, scheduledTime: number): Promise<RunReport> {
  const start = deps.now();
  // The request ceiling is raised for the bootstrap run once the snapshot is known to be pending.
  const net = makeNet(deps.fetch, deps.now, deps.sleep, start + RUN_DEADLINE_MS, MAX_HTTP_REQUESTS);
  const env = deps.env;
  const report: RunReport = {
    kind: 'completed', reason: '', effective: false, failed: [], ping: null, pingAccepted: false,
    httpRequests: 0, doCalls: 0, telegramMessages: [], telegramConfirmed: [], committed: false,
    payload: null, plan: null, healthchecksBody: '', s3Reasons: [],
  };
  const iso = new Date(scheduledTime).toISOString();
  const finish = async (kind: PingKind, body: string) => {
    report.ping = kind;
    report.healthchecksBody = body;
    const r = await pingHealthchecks(net, env.healthchecksUrl, kind, body, env.dryRun, deps.log);
    report.pingAccepted = r.accepted;
    report.httpRequests = net.requests;
    deps.log(`[watchdog] ${iso} ${report.kind} ${report.effective ? 'effective' : 'ineffective ' + report.failed.join(',')} ping=${kind}${r.accepted ? '' : ' (not accepted: ' + r.reason + ')'}`);
    return report;
  };

  // 1. Acquire the lease.
  let acq: AcquireResult;
  try {
    report.doCalls++;
    acq = await deps.state.acquire(scheduledTime, deps.now());
  } catch {
    report.kind = 'state_unavailable';
    report.failed = ['S8'];
    return finish('fail', `mako-watchdog ${iso}\nstate unavailable: the Durable Object did not answer\n${manifestLine([], ['ds'])}`);
  }
  if (!acq.ok) {
    report.kind = 'skipped';
    report.reason = acq.reason;
    report.failed = ['S8'];
    return finish('log', `mako-watchdog ${iso}\nskipped: ${acq.reason === 'lease_held' ? 'lease held by another run' : 'event not newer than the last accepted run'}`);
  }
  const snap = acq.snapshot;
  const meta = snap.meta;

  // 2, 3, 6. Provider B (one request in flight), resolver RPC and due probes in parallel.
  const due = dueProbes(scheduledTime);
  const runIndex = Math.floor(scheduledTime / 300_000);
  const bootstrapping = !meta.resolvedBootstrapped;
  if (bootstrapping) net.maxRequests = MAX_HTTP_REQUESTS_BOOTSTRAP;
  const discP = discover(net, env.providerBUrl, env.makoAddress, env.resolverAddress);
  const scanTask = async (): Promise<{ d: DiscoveryResult; plan: ScanPlan | null; pages: PageOutcome | null }> => {
    const d = await discP;
    if (!d.ok) return { d, plan: null, pages: null };
    const plan = planScan(d.value.nextMarketId, meta.creationCursor, runIndex);
    const pages = await readPages(net, env.providerBUrl, env.makoAddress, d.value.finalizedBlock, d.value.nextMarketId, plan.ids);
    return { d, plan, pages };
  };
  // The public RPC: the rr probe, then (bootstrap only) every id below N at the
  // snapshot block, in parallel with provider B's pages; one request in flight.
  const publicTask = async (): Promise<{ pub: Awaited<ReturnType<typeof readPublicRpc>>; boot: PublicRead | null }> => {
    const pub = await readPublicRpc(net, env.publicRpcUrl);
    if (!bootstrapping) return { pub, boot: null };
    const d = await discP;
    if (!d.ok || d.value.nextMarketId > BOOTSTRAP_MAX_IDS) return { pub, boot: null };
    const ids = Array.from({ length: d.value.nextMarketId }, (_, i) => i);
    return { pub, boot: await readPublicAtBlock(net, env.publicRpcUrl, env.makoAddress, d.value, ids, BOOTSTRAP_PUBLIC_REQUESTS) };
  };
  const probeTasks: (() => Promise<ProbeResult>)[] = [];
  if (due.nc) probeTasks.push(() => probeComments(net, env.appUrl));
  if (due.mp) probeTasks.push(() => probeMarketPage(net, env.appUrl));
  if (due.ch) probeTasks.push(() => probeCharts(net, env.appUrl));
  const [scan, publicSide, probes] = await Promise.all([scanTask(), publicTask(), inGroups(probeTasks, MAX_PARALLEL - 2)]);
  const pub = publicSide.pub;
  const d = scan.d.ok ? scan.d.value : null;
  const plan = scan.plan;
  report.plan = plan;
  const reads: Map<number, MarketHead | null> = scan.pages?.reads ?? new Map();
  const nowS = d?.finalizedTimestamp ?? Math.floor(scheduledTime / 1000);

  // Delivery state needed before confirmation (which commands are due).
  const prevCrit = new Map(snap.criticals.map((c) => [c.key, c]));
  const prevWarn = new Map(snap.warnings.map((w) => [w.key, w]));
  const today = iso.slice(0, 10);
  const digestDue = new Date(scheduledTime).getUTCHours() >= DIGEST_HOUR_UTC && meta.lastDigestDate !== today;
  const critDue = (key: string) => {
    const p = prevCrit.get(key);
    return !p || p.lastDeliveredAt === null || scheduledTime - p.lastDeliveredAt >= REMINDER_MS;
  };

  // Second-source confirmation (reviews r1 to r3). Before any one-way
  // transition (a resolved bit, the creation cursor crossing an id) and before
  // any refund command, the public RPC re-reads those markets at the same
  // finalized block. Fair order: new resolutions, then the prefix ids the
  // cursor would cross, then refund commands whose alert is due this run (a
  // command not due is not checked). The bootstrap run compares every id
  // below N from its parallel public read.
  const bitsBefore = bitsFromHex(snap.resolvedBits);
  const commandIds = [...reads.values()]
    .filter((m): m is MarketHead => !!m && commandAllowed(m, nowS))
    .filter((m) => (m.mType === MARKET_TYPE.MAKO ? prevWarn.get(`w:${m.id}`)?.deliveredAt == null || digestDue : critDue(`m:${m.id}`)))
    .map((m) => m.id)
    .sort((a, b) => a - b);
  const transitionIds = transitionCandidates(bitsBefore, reads);
  const cursorIds: number[] = [];
  if (plan) for (let id = plan.prefixStart; id < plan.prefixEnd && reads.get(id); id++) cursorIds.push(id);
  const oneWay = new Set([...transitionIds, ...cursorIds]);
  const toConfirm = [...new Set([...transitionIds, ...cursorIds, ...commandIds])];
  const emptyConfirmation: Confirmation = { confirmed: new Set(), disagreed: [], deferred: [], unread: [], unavailable: false, reason: '' };
  let confirmation: Confirmation = emptyConfirmation;
  if (d && bootstrapping) {
    confirmation = publicSide.boot
      ? compareHeads(Array.from({ length: d.nextMarketId }, (_, i) => i), reads, publicSide.boot)
      : { ...emptyConfirmation, unavailable: true, reason: d.nextMarketId > BOOTSTRAP_MAX_IDS ? 'too many markets to bootstrap in one run' : 'public RPC not read' };
  } else if (d && toConfirm.length) {
    confirmation = await confirmAtBlock(net, env.publicRpcUrl, env.makoAddress, d, toConfirm, reads);
  }
  const commandStatus = (id: number): 'confirmed' | 'withheld' | 'deferred' | 'unchecked' =>
    confirmation.confirmed.has(id)
      ? 'confirmed'
      : confirmation.deferred.includes(id)
        ? 'deferred'
        : commandIds.includes(id)
          ? 'withheld'
          : 'unchecked';

  // Probe checks, with flap control. Providers disagreeing at one block hash
  // is a provider-B failure observation (one of the two is wrong).
  const pbObs = probeProviderB(scan.d, meta.lastLatestBlock);
  const pbFinal: ProbeResult =
    confirmation.disagreed.length && d
      ? { code: 'pb', obs: 'fail', detail: `provider B and the resolver RPC disagree at block ${d.finalizedBlock} on #${formatRanges(confirmation.disagreed)}` }
      : pbObs;
  const observations: ProbeResult[] = [pbFinal, probeResolverRpc(pub, d?.latestBlock ?? null), ...probes];
  const checks = new Map(snap.checks.map((c) => [c.code, c]));
  for (const o of observations) checks.set(o.code, applyFlap(checks.get(o.code), o.code, o.obs, o.detail, scheduledTime));

  // 4. Discovery diff: bits only for confirmed resolutions.
  const disc = d
    ? applyDiscovery({
        bootstrapped: meta.resolvedBootstrapped,
        bits: bitsBefore,
        reads,
        confirmed: confirmation.confirmed,
        n: d.nextMarketId,
        block: d.finalizedBlock,
        scheduledTime,
      })
    : null;

  // 5. Classification.
  const crit = new Map<string, CriticalRow>();
  const keepCrit = (key: string, line: string, marketId: number | null, code: string | null) => {
    const p = prevCrit.get(key);
    crit.set(key, { key, since: p?.since ?? scheduledTime, lastDeliveredAt: p?.lastDeliveredAt ?? null, line, marketId, code });
  };
  const warn = new Map<string, WarningRow>();
  const keepWarn = (key: string, line: string) => {
    const p = prevWarn.get(key);
    // A warning is announced once; its text may change (the age grows) without a new message.
    warn.set(key, { key, since: p?.since ?? scheduledTime, deliveredAt: p?.deliveredAt ?? null, line });
  };

  // Market-level rows for markets not read this run are kept unchanged.
  for (const c of snap.criticals) if (c.marketId !== null && !reads.get(c.marketId)) crit.set(c.key, c);
  for (const w of snap.warnings) {
    const id = w.key.startsWith('w:') ? Number(w.key.slice(2)) : null;
    if (id !== null && !reads.get(id)) warn.set(w.key, w);
  }
  const commandCritical: number[] = [];
  const commandWarn: number[] = [];
  const digestLines: string[] = [];
  for (const [id, m] of reads) {
    if (!m) continue;
    const v = classifyStuck(m, nowS, commandAllowed(m, nowS) ? commandStatus(id) : 'unchecked');
    if (v.severity === 'critical') {
      keepCrit(`m:${id}`, v.line, id, null);
      if (v.command) commandCritical.push(id);
    } else if (v.severity === 'warn' || v.severity === 'digest') {
      keepWarn(`w:${id}`, v.line);
      if (v.command) commandWarn.push(id);
      if (v.severity === 'digest') digestLines.push(v.line);
    }
    const uo = unsupportedOracle(m, nowS);
    if (uo) keepCrit(`u:${id}`, uo, id, null);
  }
  // Commands only ever for one-sided markets past close + 24h, confirmed by
  // the public RPC at the same block (I7).
  for (const id of [...commandCritical, ...commandWarn]) {
    const m = reads.get(id);
    if (!m || !commandAllowed(m, nowS) || !confirmation.confirmed.has(id)) throw new Error('invariant I7: command for a market that does not qualify');
  }

  // Check-level criticals and warnings.
  for (const code of ['pb', 'rr', 'nc', 'mp']) {
    const c = checks.get(code);
    if (c?.state === 'fail') keepCrit(`c:${code}`, `CHECK ${code}: ${c.detail}`, null, code);
  }
  const chk = checks.get('ch');
  if (chk?.state === 'fail') keepWarn('c:ch', `CHECK ch: ${chk.detail}`);
  // Chain-derived checks. When the value was not read this run, the stored
  // row is kept as it was: an unread value is never a recovery.
  const carryCrit = (key: string) => {
    const p = prevCrit.get(key);
    if (p) crit.set(key, p);
  };
  const carryWarn = (key: string) => {
    const p = prevWarn.get(key);
    if (p) warn.set(key, p);
  };
  if (!d) carryCrit('c:se');
  else if (d.nextMarketId > ENVELOPE_N) {
    keepCrit('c:se', `CHECK se: ${d.nextMarketId} markets, past the ${ENVELOPE_N}-market envelope; full-state coverage is unavailable`, null, 'se');
  }
  const resolverLower = env.resolverAddress.toLowerCase();
  if (!d || d.resolver === null) carryCrit('c:rv');
  else if (d.resolver !== resolverLower) {
    keepCrit('c:rv', `CHECK rv: resolver() is ${d.resolver}, expected ${resolverLower}`, null, 'rv');
  }
  if (!d || d.resolverBalanceWei === null) carryWarn('bal');
  else if (d.resolverBalanceWei < RESOLVER_BALANCE_WARN_WEI) {
    keepWarn('bal', `resolver ${resolverLower} balance ${fmtMon(d.resolverBalanceWei)} MON, below ${fmtMon(RESOLVER_BALANCE_WARN_WEI)}`);
  }

  // Notes: recoveries of delivered check-level items, and the bootstrap summary.
  const notes = new Map<string, NoteRow>(snap.notes.map((n) => [n.key, n]));
  for (const p of snap.criticals) {
    if (p.code && p.lastDeliveredAt !== null && !crit.has(p.key)) {
      notes.set(`rec:${p.key}:${scheduledTime}`, { key: `rec:${p.key}:${scheduledTime}`, createdAt: scheduledTime, text: `RECOVERED ${p.code}` });
    }
  }
  for (const p of snap.warnings) {
    if ((p.key === 'c:ch' || p.key === 'bal') && p.deliveredAt !== null && !warn.has(p.key)) {
      notes.set(`rec:${p.key}:${scheduledTime}`, { key: `rec:${p.key}:${scheduledTime}`, createdAt: scheduledTime, text: `RECOVERED ${p.key === 'bal' ? 'resolver balance' : 'ch'}` });
    }
  }
  if (disc?.bootstrapResolved && d) {
    const ids = disc.bootstrapResolved;
    notes.set('bootstrap', {
      key: 'bootstrap',
      createdAt: scheduledTime,
      text:
        `Watchdog started at finalized block ${d.finalizedBlock}. Resolved before the watchdog, not audited ` +
        `(${ids.length}): ${ids.length ? formatRanges(ids) : 'none'}`,
    });
  }

  // Creation checks over the prefix, in id order.
  const bootstrapN = meta.bootstrapN ?? d?.nextMarketId ?? null;
  const creation: { id: number; key: string; line: string }[] = [];
  // The cursor crosses an id only once the public RPC confirmed its read.
  let firstUnconfirmed: number | null = null;
  if (plan && bootstrapN !== null) {
    for (let id = plan.prefixStart; id < plan.prefixEnd; id++) {
      const m = reads.get(id);
      if (!m) break; // the cursor stops here anyway
      if (!confirmation.confirmed.has(id)) {
        firstUnconfirmed = id;
        break;
      }
      creationFindings(m, id < bootstrapN).forEach((line, k) => creation.push({ id, key: `n:${id}:${k}`, line }));
    }
  }

  // 7. Due items.
  const critList = [...crit.values()];
  const dueCrit = critList
    .filter((c) => c.lastDeliveredAt === null || scheduledTime - c.lastDeliveredAt >= REMINDER_MS)
    .sort(critOrder);
  const critMarketIds = critList.filter((c) => c.marketId !== null).map((c) => c.marketId as number);
  const critCodes = critList.filter((c) => c.code).map((c) => c.code as string);
  if (critList.some((c) => c.key.startsWith('u:'))) critCodes.push('uo');

  const nonCrit: { key: string; line: string }[] = [
    ...creation.map((c) => ({ key: c.key, line: c.line })),
    ...[...notes.values()].sort((a, b) => a.createdAt - b.createdAt).map((n) => ({ key: n.key, line: n.text })),
    ...[...warn.values()].filter((w) => w.deliveredAt === null).map((w) => ({ key: w.key, line: `WARN ${w.line}` })),
  ];
  // commandWarn holds only confirmed commands, which were checked only when due
  // (a new warning or today's digest).
  const dueWarnCommand = commandWarn;
  if (dueWarnCommand.length) nonCrit.push({ key: 'cmd', line: refundCommand(env.makoAddress, dueWarnCommand) });
  if (digestDue) nonCrit.push({ key: 'digest', line: digestText(d, reads, crit.size, [...warn.values()], digestLines, snap.auditQueueSize + (disc?.auditAppend.length ?? 0)) });

  // 8. Telegram.
  const texts: string[] = [];
  let critPack: ReturnType<typeof packCriticals> | null = null;
  const manifest = manifestLine(critMarketIds, critCodes);
  if (dueCrit.length) {
    const cmdIds = commandCritical.filter((id) => crit.has(`m:${id}`));
    critPack = packCriticals(
      `MAKO WATCHDOG: ${dueCrit.length} critical due, ${critList.length} open (block ${d?.finalizedBlock ?? '?'})`,
      dueCrit.map((c) => ({ key: c.key, line: c.line })),
      cmdIds.length ? refundCommand(env.makoAddress, cmdIds) : null,
      manifest,
      undefined,
      undefined,
      critMarketIds.length,
    );
    texts.push(...critPack.messages);
  }
  const nc = packNonCritical(`MAKO WATCHDOG notices (${iso.slice(0, 16).replace('T', ' ')} UTC)`, nonCrit);
  if (nc.message) texts.push(nc.message);
  let confirmed: boolean[] = [];
  if (net.now() < net.deadlineAt && texts.length) {
    confirmed = await sendTelegram(net, { token: env.telegramToken, chatId: env.telegramChatId, dryRun: env.dryRun, log: deps.log }, texts);
  } else {
    confirmed = texts.map(() => false);
  }
  report.telegramMessages = texts;
  report.telegramConfirmed = confirmed;
  const critMsgCount = critPack?.messages.length ?? 0;
  const criticalsDelivered = critMsgCount === 0 || confirmed.slice(0, critMsgCount).every(Boolean);
  const nonCritConfirmed = nc.message !== null && confirmed[critMsgCount] === true;
  const placedNonCrit = new Set(nonCritConfirmed ? nc.placedKeys : []);

  // Delivery bookkeeping.
  if (critPack) {
    for (const p of critPack.placed) {
      const row = crit.get(p.key)!;
      // A refund command deferred for budget keeps its alert due, so the next
      // run confirms it first (no starvation, review r3).
      const commandDeferred = row.marketId !== null && p.key.startsWith('m:') && commandStatus(row.marketId) === 'deferred';
      if (confirmed[p.message] && !commandDeferred) crit.set(p.key, { ...row, lastDeliveredAt: scheduledTime });
    }
  }
  for (const [key, w] of warn) if (w.deliveredAt === null && placedNonCrit.has(key)) warn.set(key, { ...w, deliveredAt: scheduledTime });
  for (const key of [...notes.keys()]) if (placedNonCrit.has(key)) notes.delete(key);

  // Creation cursor: stops at the first unread prefix id, or at the first id
  // whose creation alert Telegram did not confirm.
  let stopAt: number | null = firstUnconfirmed;
  for (const c of creation) {
    if (!placedNonCrit.has(c.key)) {
      stopAt = stopAt === null ? c.id : Math.min(stopAt, c.id);
      break;
    }
  }
  const newCursor = plan ? advanceCursor(plan, reads, stopAt) : meta.creationCursor;

  const nextMeta = {
    ...meta,
    creationCursor: newCursor,
    bootstrapN,
    resolvedBootstrapped: disc?.bootstrapped ?? meta.resolvedBootstrapped,
    snapshotBlock: disc?.bootstrapResolved && d ? d.finalizedBlock : meta.snapshotBlock,
    // The last validated value, not a maximum: one bad answer must not pin the
    // advancing-block check forever (review r1 finding 1).
    lastLatestBlock: d ? d.latestBlock : meta.lastLatestBlock,
    lastDigestDate: digestDue && placedNonCrit.has('digest') ? today : meta.lastDigestDate,
    // Pending only while a creation alert waits for Telegram (S3); waiting on
    // confirmation shows up in S1 instead.
    creationPendingSince: stopAt !== null && stopAt !== firstUnconfirmed ? (meta.creationPendingSince ?? scheduledTime) : null,
  };
  const payload: CommitPayload = {
    meta: nextMeta,
    checks: [...checks.values()],
    criticals: [...crit.values()],
    warnings: [...warn.values()],
    notes: [...notes.values()],
    resolvedBits: disc ? bitsToHex(disc.bits) : snap.resolvedBits,
    auditAppend: disc?.auditAppend ?? [],
  };
  report.payload = payload;

  // 9. Commit, unless the deadline passed (then nothing more is sent).
  if (net.now() >= net.deadlineAt) {
    report.kind = 'deadline';
    report.failed = ['S6'];
    report.httpRequests = net.requests;
    deps.log(`[watchdog] ${iso} deadline passed before commit; nothing committed`);
    return report;
  }
  let commitOk = false;
  try {
    report.doCalls++;
    const r = await deps.state.commit(snap.token, scheduledTime, payload);
    commitOk = r.ok;
    if (!r.ok) report.reason = `commit rejected: ${r.reason}`;
  } catch {
    report.reason = 'commit failed';
  }
  report.committed = commitOk;

  // Effective-run conditions (r15 §5.6; S9 and S10 wait for slice 2).
  const failed: string[] = [];
  const allRead = !!plan && plan.ids.every((id) => !!reads.get(id)) && !!d && d.resolver !== null && d.resolverBalanceWei !== null && d.nextMarketId >= meta.creationCursor;
  // Every id that needed a second source this run got one (budget deferral of
  // a large bootstrap is staged progress, not a failure).
  const allConfirmed = !confirmation.unavailable && !confirmation.disagreed.length && !confirmation.unread.length;
  // A deferred one-way transition or cursor id is unfinished required work
  // (review r3); only refund-command deferral may leave a run effective.
  const oneWayDeferred = confirmation.deferred.some((id) => oneWay.has(id));
  const bootstrapDone = disc?.bootstrapped ?? meta.resolvedBootstrapped;
  if (!allRead || !allConfirmed || oneWayDeferred || !bootstrapDone) failed.push('S1');
  if (observations.some((o) => o.obs === 'fail' && PROBE_UNCLASSIFIED.test(o.detail))) failed.push('S2');
  const staleNonCrit =
    payload.warnings.some((w) => w.deliveredAt === null && scheduledTime - w.since > NONCRITICAL_MAX_WAIT_MS) ||
    payload.notes.some((n) => scheduledTime - n.createdAt > NONCRITICAL_MAX_WAIT_MS) ||
    (nextMeta.creationPendingSince !== null && scheduledTime - nextMeta.creationPendingSince > NONCRITICAL_MAX_WAIT_MS) ||
    (digestDue && !placedNonCrit.has('digest') && scheduledTime - digestDueAt(scheduledTime) > NONCRITICAL_MAX_WAIT_MS);
  const s3: string[] = [];
  if (!criticalsDelivered) s3.push('critical undelivered');
  if (staleNonCrit) s3.push('non-critical waiting over 30 min');
  if (critPack?.manifestTruncated) s3.push('manifest truncated');
  if (s3.length) failed.push('S3');
  report.s3Reasons = s3;
  if (!commitOk) failed.push('S4');
  if (net.requests + report.doCalls > net.maxRequests + 2 || deps.now() - start >= RUN_DEADLINE_MS) failed.push('S6');
  if (d && d.nextMarketId > ENVELOPE_N) failed.push('S7');
  report.failed = failed;
  report.effective = failed.length === 0;

  // 10. Healthchecks: success only for an effective run; /fail when due
  // criticals did not reach Telegram; otherwise /log.
  const runCodes = [...critCodes];
  if (!criticalsDelivered) runCodes.push('tg');
  if (!commitOk) runCodes.push('ds');
  const body = [
    `mako-watchdog ${iso} ${report.effective ? 'effective' : 'INEFFECTIVE ' + failed.join(',')}${s3.length ? ' (' + s3.join('; ') + ')' : ''}`,
    manifestLine(critMarketIds, runCodes),
    d
      ? `block ${d.finalizedBlock} (latest ${d.latestBlock}), markets ${d.nextMarketId}, read ${countRead(reads)}/${plan?.ids.length ?? 0}, cursor ${meta.creationCursor}->${newCursor}, audit queue ${snap.auditQueueSize + payload.auditAppend.length}`
      : `provider B: ${scan.d.ok ? '' : scan.d.reason}`,
    `telegram ${confirmed.filter(Boolean).length}/${texts.length} confirmed, requests ${net.requests + report.doCalls}, ${deps.now() - start} ms${report.reason ? ', ' + report.reason : ''}`,
    ...(toConfirm.length
      ? [
          `second source: ${confirmation.confirmed.size}/${toConfirm.length} confirmed at the same block` +
            (confirmation.deferred.length ? `, ${confirmation.deferred.length} deferred` : '') +
            (confirmation.reason ? ` (${confirmation.reason})` : '') +
            (commandIds.length ? `; refund commands ${commandIds.filter((id) => confirmation.confirmed.has(id)).length}/${commandIds.length}` : '') +
            (bootstrapping ? (disc?.bootstrapped ? `; bootstrap snapshot at block ${d?.finalizedBlock}` : '; bootstrap NOT complete (every id below N must match at one block)') : ''),
        ]
      : []),
    ...[...critList].sort(critOrder).map((c) => c.line),
  ].join('\n');
  const kind: PingKind = report.effective ? 'success' : !criticalsDelivered ? 'fail' : 'log';
  if (deps.now() >= net.deadlineAt) {
    report.kind = 'deadline';
    report.httpRequests = net.requests;
    return report;
  }
  return finish(kind, body);
}

function critOrder(a: CriticalRow, b: CriticalRow): number {
  const ra = a.code ? 0 : 1;
  const rb = b.code ? 0 : 1;
  if (ra !== rb) return ra - rb;
  if (a.marketId !== null && b.marketId !== null && a.marketId !== b.marketId) return a.marketId - b.marketId;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function digestDueAt(scheduledTime: number): number {
  const t = new Date(scheduledTime);
  return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), DIGEST_HOUR_UTC);
}

function countRead(reads: Map<number, MarketHead | null>): number {
  let n = 0;
  for (const v of reads.values()) if (v) n++;
  return n;
}

function fmtMon(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n) / 10n ** 16n;
  return `${whole}.${frac.toString().padStart(2, '0')}`;
}

function digestText(
  d: { finalizedBlock: number; nextMarketId: number } | null,
  reads: Map<number, MarketHead | null>,
  criticalCount: number,
  warnings: WarningRow[],
  makoLines: string[],
  auditQueue: number,
): string {
  let open = 0;
  let pool = 0n;
  for (const m of reads.values()) {
    if (m && !m.resolved) {
      open++;
      pool += m.totalYes + m.totalNo;
    }
  }
  const lines = [
    `DAILY DIGEST: ${d ? `${d.nextMarketId} markets, ${open} open holding ${fmtUsdc(pool)} USDC, block ${d.finalizedBlock}` : 'provider B unavailable'}`,
    `criticals open: ${criticalCount}; warnings: ${warnings.length}`,
    `resolver report: not deployed; settlement audit: slice 2 (queue ${auditQueue})`,
    ...makoLines.map((l) => `MAKO ${l}`),
    ...warnings.filter((w) => !w.key.startsWith('w:') || !makoLines.includes(w.line)).map((w) => `WARN ${w.line}`),
  ];
  let text = lines.join('\n');
  if (text.length > 2500) text = text.slice(0, 2480) + '\n+more (see Healthchecks)';
  return text;
}
