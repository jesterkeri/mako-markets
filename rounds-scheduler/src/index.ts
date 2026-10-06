// mako-rounds-scheduler: keeps Mako's own BTC rounds on the calendar. Every 5 minutes it reads MakoRoundsV1, decides
// with planSchedule (src/plan.ts) whether an upcoming slot needs a round, and if so has that slot's house creator
// call `schedule`. It holds the two house creator keys and nothing else; it never enters, settles, refunds or moves
// USDC. Every rule it applies the contract enforces again, so a mistake here can at worst waste gas on a refusal.

import { createPublicClient, defineChain, encodeFunctionData, getAddress, http, keccak256, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { MAX_LEAD_S, planSchedule, type ChainView, type HouseView } from './plan';
import { type Acquired, type SchedulerState, type SendIntent } from './state';

export { SchedulerState } from './state';

export interface Env {
  SCHEDULER_STATE?: DurableObjectNamespace<SchedulerState>;
  RPC_URL: string;
  ROUNDS_ADDRESS: string;
  HOUSE_1_ADDRESS: string;
  HOUSE_2_ADDRESS: string;
  /// Seconds between rounds; a whole number of minutes.
  INTERVAL_S: string;
  /// "true" (the default until Joshua says otherwise): plan and log, send nothing.
  DRY_RUN: string;
  HOUSE_1_PRIVATE_KEY: string;
  HOUSE_2_PRIVATE_KEY: string;
}

export const ROUNDS_ABI = parseAbi([
  'function creatorActiveRound(address) view returns (uint256)',
  'function activeRoundCount() view returns (uint256)',
  'function MAX_ACTIVE_ROUNDS() view returns (uint256)',
  'function isCreator(address) view returns (bool)',
  'function roundCount() view returns (uint256)',
  'function phaseOf(uint256) view returns (uint8)',
  'function roundOf(uint256) view returns ((address creator, uint64 openTime, uint64 startTime, uint8 status, uint8 outcome, uint8 refundReason, int192 anchorPrice, int192 closePrice, uint32 anchorObservedAt, uint32 closeObservedAt, bytes32 anchorReportHash, bytes32 closeReportHash, uint256 upPool, uint256 downPool, uint32 upEntrants, uint32 downEntrants, uint256 protocolFee, uint256 creatorFee, uint256 distributable, uint32 winnersClaimed, uint256 paidOut))',
  'function schedule(uint64 startTime) returns (uint256)',
]);

/// Rounds read per Multicall3 call while looking back for unfinished rounds, and the most such calls in one run.
const SCAN_PAGE = 40;
export const MAX_SCAN_PAGES = 10;
/// MakoRoundsV1's fixed durations (SPEC §4).
const DURATION_S = 900;
const SUBMIT_WINDOW_S = 86_400;

const monad = defineChain({
  id: 10143,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: ['https://testnet-rpc.monad.xyz/'] } },
  contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
});

export const isDryRun = (env: Pick<Env, 'DRY_RUN'>): boolean => env.DRY_RUN !== 'false';

export type RunResult = { ok: true; scheduled: { house: number; startTime: number; tx?: Hex }[]; skips: string[] } | { ok: false; error: string };

/// The run lease, held across the whole run, and the one durable send intent (src/state.ts).
export interface Lease {
  acquire(nowMs: number): Promise<Acquired>;
  release(token: number): Promise<{ ok: boolean }>;
  /// The unresolved intent, for the lease holder only.
  intent(token: number, nowMs: number): Promise<{ ok: true; intent: SendIntent | null } | { ok: false }>;
  /// Records a signed transaction before it is sent; refused unless `token` holds the lease and no intent is open.
  recordIntent(token: number, nowMs: number, intent: SendIntent): Promise<{ ok: boolean }>;
  clearIntent(token: number, nowMs: number, hash: `0x${string}`): Promise<{ ok: boolean }>;
}

export interface RunDeps {
  lease: Lease;
  /// Milliseconds, for the lease and the send deadline.
  clockMs: () => number;
  /// Test seam: awaited after the transaction is signed and before its intent is recorded, which is where stalled
  /// reads or a slow signature would leave a run.
  beforeSend?: () => Promise<void>;
  /// Test seam: awaited after the intent is recorded and before the transaction is sent.
  afterRecord?: () => Promise<void>;
}

/// The one send request is abandoned after this long (no retries); the intent keeps it for the next run.
export const SEND_TIMEOUT_MS = 20_000;
/// Each read request is abandoned after this long, with no retry.
export const READ_TIMEOUT_MS = 10_000;

/// The most subrequests one run can make. Cloudflare counts every fetch and every Durable Object call
/// (developers.cloudflare.com/workers/platform/limits/#subrequests); both RPC clients make no retries, so each read
/// below is exactly one fetch (test/budget.test.ts drives the worst path offline). wrangler.toml's [limits] subrequests must
/// stay at or above this (test/subrequests.e2e.test.ts reads both). The paths, each ending the run:
///   - lease refused: 1 (acquire);
///   - open intent: acquire, intent, latest nonce, then either a rebroadcast, or a receipt and clearIntent, then
///     release: at most 7;
///   - plan and send: acquire, intent, the state multicall, up to MAX_SCAN_PAGES scan pages, the simulation, the
///     pending and latest nonces, estimateGas, the fee reads (the block and eth_maxPriorityFeePerGas, plus
///     eth_gasPrice when viem falls back because the priority-fee read failed; Codex Rounds r5), recordIntent, the
///     send, release: 13 + MAX_SCAN_PAGES with the fallback, one fewer without (both counted exactly by
///     test/budget.test.ts).
export const WORST_CASE_SUBREQUESTS = 13 + MAX_SCAN_PAGES;

export async function runScheduler(env: Env, nowS: number, deps: RunDeps): Promise<RunResult> {
  const startMs = deps.clockMs();
  const lease = await deps.lease.acquire(startMs);
  if (!lease.ok) return { ok: true, scheduled: [], skips: ['another run holds the lease; nothing done'] };
  try {
    return await runLocked(env, nowS, deps, lease.token);
  } finally {
    await deps.lease.release(lease.token);
  }
}

async function runLocked(env: Env, nowS: number, deps: RunDeps, token: number): Promise<RunResult> {
  const rounds = getAddress(env.ROUNDS_ADDRESS.trim());
  const houses = [getAddress(env.HOUSE_1_ADDRESS.trim()), getAddress(env.HOUSE_2_ADDRESS.trim())] as const;
  const intervalS = Number(env.INTERVAL_S);
  // Sends only when DRY_RUN is exactly "false"; anything else, " false" included, is a dry run (adversary on 0c123a2).
  const dryRun = isDryRun(env);
  // No retries on reads either (Codex Rounds r4): viem's default retries a 408/429/5xx up to 3 times, each a separate
  // subrequest, which WORST_CASE_SUBREQUESTS does not count. A failed read ends this run; the next cron tries again.
  const client = createPublicClient({
    chain: monad,
    transport: http(env.RPC_URL.trim(), { timeout: READ_TIMEOUT_MS, retryCount: 0 }),
    batch: { multicall: true },
  });
  const c = { address: rounds, abi: ROUNDS_ABI } as const;
  const sender = createPublicClient({ chain: monad, transport: http(env.RPC_URL.trim(), { timeout: SEND_TIMEOUT_MS, retryCount: 0 }) });
  const skips: string[] = [];

  // An earlier run's recorded send comes first (Codex Rounds r3). Until the chain shows its nonce used, nothing new
  // is scheduled: the same signed transaction is rebroadcast instead, so a late send by the run that recorded it is
  // that same transaction and only one of them can ever execute.
  const open = await deps.lease.intent(token, deps.clockMs());
  if (!open.ok) return { ok: true, scheduled: [], skips: ['lease lost; nothing done'] };
  if (open.intent) {
    const i = open.intent;
    const used = await client.getTransactionCount({ address: i.house, blockTag: 'latest' });
    if (used <= i.nonce) {
      if (!dryRun) await sender.sendRawTransaction({ serializedTransaction: i.raw }).catch(() => null);
      const at = new Date(i.startTime * 1000).toISOString();
      return { ok: true, scheduled: [], skips: [`${at} earlier send ${i.hash} (nonce ${i.nonce}) not mined yet; ${dryRun ? 'dry run, not rebroadcast' : 'rebroadcast it'}, nothing new sent`] };
    }
    const receipt = await client.getTransactionReceipt({ hash: i.hash }).catch(() => null);
    const how = receipt ? (receipt.status === 'success' ? 'landed' : 'reverted') : 'its nonce was used by another transaction';
    const cleared = await deps.lease.clearIntent(token, deps.clockMs(), i.hash);
    if (!cleared.ok) return { ok: true, scheduled: [], skips: ['lease lost while clearing the earlier send; nothing done'] };
    // Clearing is this run's one job: the next run books. Each house holds at most one unfinished round, so waiting one
    // cron period costs nothing, and it keeps every run inside WORST_CASE_SUBREQUESTS (adversary on 3f08d05).
    return { ok: true, scheduled: [], skips: [`earlier send ${i.hash}: ${how}; cleared, the next run plans`] };
  }

  // One Multicall3 call: both houses' unfinished rounds, the count, the cap, and that both are still creators.
  const [a1, a2, count, cap, isC1, isC2, total] = await client.multicall({
    allowFailure: false,
    // One request, never chunked: viem otherwise splits calldata over 1024 bytes into several eth_calls, each a
    // subrequest that WORST_CASE_SUBREQUESTS would not count (found by test/budget.test.ts).
    batchSize: 0,
    contracts: [
      { ...c, functionName: 'creatorActiveRound', args: [houses[0]] },
      { ...c, functionName: 'creatorActiveRound', args: [houses[1]] },
      { ...c, functionName: 'activeRoundCount' },
      { ...c, functionName: 'MAX_ACTIVE_ROUNDS' },
      { ...c, functionName: 'isCreator', args: [houses[0]] },
      { ...c, functionName: 'isCreator', args: [houses[1]] },
      { ...c, functionName: 'roundCount' },
    ],
  });
  if (!isC1 || !isC2) return { ok: false, error: 'a house address is not on the creator list' };

  // Every round that can still be unfinished, for start times already taken by anyone and the houses' own start
  // times. Not just the newest few: a round booked up to 7 days ahead stays unfinished until 24H after its close,
  // and the contract does not refuse a second round at the same start (adversary on 0c123a2). Round ids grow in
  // scheduling order, so reading back from the newest until a round opened before that horizon covers them all.
  const horizon = nowS - (MAX_LEAD_S + DURATION_S + SUBMIT_WINDOW_S + 3600);
  const startOf = new Map<bigint, number>();
  const scheduledStarts: number[] = [];
  let next = total as bigint;
  for (let page = 0; next >= 1n; page++) {
    if (page >= MAX_SCAN_PAGES) return { ok: false, error: 'more unfinished-round candidates than one run can read; nothing sent' };
    const ids: bigint[] = [];
    for (let id = next; id >= 1n && ids.length < SCAN_PAGE; id--) ids.push(id);
    next -= BigInt(ids.length);
    const reads = await client.multicall({
      allowFailure: false,
      batchSize: 0, // one request per page, never chunked (see the state read above)
      contracts: ids.flatMap((id) => [
        { ...c, functionName: 'roundOf', args: [id] },
        { ...c, functionName: 'phaseOf', args: [id] },
      ]),
    });
    let reachedHorizon = false;
    ids.forEach((id, i) => {
      const r = reads[2 * i] as unknown as { openTime: bigint; startTime: bigint };
      const phase = Number(reads[2 * i + 1]);
      startOf.set(id, Number(r.startTime));
      // Phase 4 Settled, 5 Refunded: finished; anything else is unfinished.
      if (phase !== 4 && phase !== 5) scheduledStarts.push(Number(r.startTime));
      if (Number(r.openTime) < horizon) reachedHorizon = true;
    });
    if (reachedHorizon) break;
  }
  const house = (addr: `0x${string}`, active: bigint): HouseView => ({ address: addr, activeRoundId: active, activeStart: active === 0n ? null : (startOf.get(active) ?? null) });
  const view: ChainView = {
    nowS,
    houses: [house(houses[0], a1 as bigint), house(houses[1], a2 as bigint)],
    activeRoundCount: count as bigint,
    maxActiveRounds: cap as bigint,
    scheduledStarts,
  };
  const plan = planSchedule(view, intervalS);
  skips.push(...plan.skips.map((s) => `${new Date(s.slot * 1000).toISOString()} ${s.reason}`));

  const keys = [env.HOUSE_1_PRIVATE_KEY, env.HOUSE_2_PRIVATE_KEY];
  const scheduled: { house: number; startTime: number; tx?: Hex }[] = [];
  // At most one round per run: the cron runs every 5 minutes, and one send keeps a run well inside the Worker's
  // subrequest limit while it waits for the receipt.
  for (const a of plan.actions.slice(0, 1)) {
    const account = privateKeyToAccount(keys[a.house].trim() as Hex);
    // The key must be the house it claims to be, or nothing is sent.
    if (account.address !== houses[a.house]) return { ok: false, error: `house ${a.house + 1} key does not match its address` };
    // Simulate first: a refusal costs nothing and is reported by name.
    try {
      await client.simulateContract({ ...c, functionName: 'schedule', args: [BigInt(a.startTime)], account });
    } catch (err) {
      skips.push(`${new Date(a.startTime * 1000).toISOString()} refused: ${(err as { shortMessage?: string }).shortMessage ?? 'simulation failed'}`);
      continue;
    }
    if (dryRun) {
      scheduled.push({ house: a.house + 1, startTime: a.startTime });
      continue;
    }
    // A transaction of this house still pending (a receipt that timed out last run) means the round may already be
    // on its way: send nothing rather than a duplicate the contract would refuse.
    const [pendingN, latestN] = await Promise.all([
      client.getTransactionCount({ address: account.address, blockTag: 'pending' }),
      client.getTransactionCount({ address: account.address, blockTag: 'latest' }),
    ]);
    if (pendingN > latestN) {
      skips.push(`${new Date(a.startTime * 1000).toISOString()} house ${a.house + 1} has a transaction pending; nothing sent`);
      continue;
    }
    // Sign first, then record the signed transaction durably, then send (Codex Rounds r3). The record succeeds only
    // while this run holds the lease and no earlier intent is open; a run whose lease ran out at any point before
    // that sends nothing, and a run delayed after it can only ever send this exact transaction, which every later
    // run rebroadcasts rather than scheduling anything else.
    const data = encodeFunctionData({ abi: ROUNDS_ABI, functionName: 'schedule', args: [BigInt(a.startTime)] });
    const [gas, fees] = await Promise.all([
      client.estimateGas({ account: account.address, to: rounds, data }),
      client.estimateFeesPerGas(),
    ]);
    const raw = await account.signTransaction({
      type: 'eip1559',
      chainId: monad.id,
      nonce: latestN,
      to: rounds,
      data,
      gas,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });
    const tx = keccak256(raw);
    await deps.beforeSend?.();
    const recorded = await deps.lease.recordIntent(token, deps.clockMs(), {
      house: account.address,
      nonce: latestN,
      startTime: a.startTime,
      hash: tx,
      raw,
      recordedAt: deps.clockMs(),
    });
    if (!recorded.ok) {
      skips.push(`${new Date(a.startTime * 1000).toISOString()} lease lost before the send was recorded; nothing sent`);
      continue;
    }
    await deps.afterRecord?.();
    try {
      await sender.sendRawTransaction({ serializedTransaction: raw });
    } catch {
      // Unknown outcome: the node may hold it. The recorded intent makes the next run rebroadcast this same transaction.
      skips.push(`${new Date(a.startTime * 1000).toISOString()} send of ${tx} (nonce ${latestN}) not acknowledged; recorded, the next run rebroadcasts it`);
      continue;
    }
    // No receipt wait: polling for it made the run's subrequest count unbounded (adversary on 3f08d05). The intent
    // stays open, so the next run sees whether its nonce was used, records how it ended, and clears it.
    scheduled.push({ house: a.house + 1, startTime: a.startTime, tx });
  }
  return { ok: true, scheduled, skips };
}

export default {
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    let result: RunResult;
    try {
      if (!env.SCHEDULER_STATE) throw new Error('SCHEDULER_STATE binding missing');
      const stub = env.SCHEDULER_STATE.get(env.SCHEDULER_STATE.idFromName('rounds-scheduler'));
      result = await runScheduler(env, Math.floor(event.scheduledTime / 1000), {
        lease: {
          acquire: (now) => stub.acquire(now),
          release: (t) => stub.release(t),
          intent: (t, now) => stub.intent(t, now),
          recordIntent: (t, now, i) => stub.recordIntent(t, now, i),
          clearIntent: (t, now, h) => stub.clearIntent(t, now, h),
        },
        clockMs: () => Date.now(),
      });
    } catch (err) {
      // Reported by kind only: an error's text could carry the RPC URL.
      result = { ok: false, error: (err as Error)?.name ?? 'error' };
    }
    console.log(JSON.stringify({ scheduler: result, dryRun: isDryRun(env), cron: event.scheduledTime }));
  },
};
