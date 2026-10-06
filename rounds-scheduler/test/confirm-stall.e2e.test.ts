// A run delayed AFTER its lease check can still send (Codex Rounds r3; adversary on 55fd16a): no clock margin bounds a
// Worker that is descheduled. The scheduler therefore records the SIGNED transaction in the Durable Object before
// sending it, and every later holder rebroadcasts exactly that transaction instead of scheduling anything new until
// its nonce is used. These cases delay run A at each point after the record, let run B take the lease over, and
// require that only ONE distinct transaction is ever broadcast and only one round created.
// Against the real MakoRoundsV1 on a local fork (anvil), never the live chain; skipped unless both are set:
//   SCHED_ANVIL_RPC=http://127.0.0.1:18546 SCHED_ROUNDS=<deployed> npx vitest run test/confirm-stall.e2e.test.ts
// (deploy as in anvil.e2e.test.ts, creators [anvil 1, anvil 0]). The keys are anvil's public development keys.
// Each case moves the fork's clock and books a round, so the runner runs each case alone (`-t`) on a fresh fork of its
// own; sharing one fork through anvil snapshots leaked state between cases.
import { createPublicClient, createTestClient, http, keccak256, parseAbi, type Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';

import { runScheduler, type Env, type Lease } from '../src/index';
import { houseOf } from '../src/plan';
import { LEASE_MS } from '../src/state';
import { memLease } from './lease-fake';

const RPC = process.env.SCHED_ANVIL_RPC ?? '';
const ROUNDS = process.env.SCHED_ROUNDS ?? '';
const URL_OR_UNUSED = RPC || 'http://127.0.0.1:1';
const H = 7200;

const env: Env = {
  RPC_URL: RPC,
  ROUNDS_ADDRESS: ROUNDS,
  HOUSE_1_ADDRESS: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  HOUSE_2_ADDRESS: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  INTERVAL_S: String(H),
  DRY_RUN: 'false',
  HOUSE_1_PRIVATE_KEY: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  HOUSE_2_PRIVATE_KEY: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
};

const pub = createPublicClient({ transport: http(URL_OR_UNUSED) });
const test = createTestClient({ mode: 'anvil', transport: http(URL_OR_UNUSED) });
const abi = parseAbi([
  'function roundCount() view returns (uint256)',
  'function roundOf(uint256) view returns ((address creator, uint64 openTime, uint64 startTime, uint8 status, uint8 outcome, uint8 refundReason, int192 anchorPrice, int192 closePrice, uint32 anchorObservedAt, uint32 closeObservedAt, bytes32 anchorReportHash, bytes32 closeReportHash, uint256 upPool, uint256 downPool, uint32 upEntrants, uint32 downEntrants, uint256 protocolFee, uint256 creatorFee, uint256 distributable, uint32 winnersClaimed, uint256 paidOut))',
]);
const count = () => pub.readContract({ address: ROUNDS as `0x${string}`, abi, functionName: 'roundCount' });
const houseAddr = (slot: number) => (houseOf(slot, H) === 0 ? env.HOUSE_1_ADDRESS : env.HOUSE_2_ADDRESS);

/// Every raw transaction broadcast while `fn` runs, by its payload.
async function capture(fn: () => Promise<void>): Promise<Hex[]> {
  const realFetch = globalThis.fetch;
  const raws: Hex[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (...a: Parameters<typeof fetch>) => {
    const body = String(a[1]?.body ?? '');
    if (body.includes('eth_sendRawTransaction')) {
      const calls = [JSON.parse(body)].flat() as { method: string; params: Hex[] }[];
      for (const c of calls) if (c.method === 'eth_sendRawTransaction') raws.push(c.params[0]);
    }
    return realFetch(...a);
  });
  try {
    await fn();
  } finally {
    vi.restoreAllMocks();
  }
  return raws;
}

/// Run A fires 1000 s before slot S1 (S1 is k slots later than the first upcoming one); run B is the next cron, 300 s later, when S1 is inside the 780 s lead floor, so
/// a fresh plan by B would book S2 = S1 + 2h from the OTHER house, which A's pinned nonce could not fence.
/// `k` puts each case on a different slot. Cases revert to the same snapshot, so without it they would sign
/// byte-identical transactions, and anvil remembers a reverted case's transaction hash (it then refuses the resend
/// and serves the stale receipt), which made a correct run look like a missing round.
async function setup(k: number) {
  const before = await count();
  const c = Number((await pub.getBlock()).timestamp);
  const S1 = Math.ceil((c + 1100) / H) * H + k * H;
  const nowA = S1 - 1000;
  await test.setNextBlockTimestamp({ timestamp: BigInt(nowA) });
  await test.mine({ blocks: 1 });
  return { before, S1, nowA, nowB: nowA + 300 };
}

/// Why a raw transaction did not produce a round, for the assertion message: the node's answer to sending it again.
async function whyNotMined(raw: Hex | undefined): Promise<string> {
  if (!raw) return 'nothing sent';
  const r = await pub.getTransactionReceipt({ hash: keccak256(raw) }).catch(() => null);
  if (!r) return pub.request({ method: 'eth_sendRawTransaction', params: [raw] }).then(() => 'not mined; accepted on resend', (e: Error) => `not mined; ${e.message}`);
  const blk = await pub.getBlock({ blockNumber: r.blockNumber });
  const tx = await pub.getTransaction({ hash: r.transactionHash });
  const why = await pub.call({ to: tx.to!, data: tx.input, account: tx.from, blockNumber: r.blockNumber - 1n }).then(() => 'replays ok', (e: Error) => e.message.split('\n').slice(0, 3).join(' '));
  const head = await pub.getBlock();
  const n = await count();
  return `mined ${r.status} in block ${r.blockNumber} at ${blk.timestamp} (tx index ${r.transactionIndex}, to ${tx.to}); replay one block earlier: ${why}; head block ${head.number} at ${head.timestamp}; roundCount now ${n}`;
}

async function created(before: bigint) {
  const out: { creator: string; startTime: number }[] = [];
  for (let id = before + 1n; id <= (await count()); id++) {
    const r = await pub.readContract({ address: ROUNDS as `0x${string}`, abi, functionName: 'roundOf', args: [id] });
    out.push({ creator: r.creator, startTime: Number(r.startTime) });
  }
  return out;
}

describe.skipIf(!RPC || !ROUNDS)('a run delayed after it recorded its send', () => {
  it('a late answer to the record: B rebroadcasts A\'s transaction and books nothing else; one transaction, one round', async () => {
    const { before, S1, nowA, nowB } = await setup(0);
    const inner = memLease();
    let t = 9_000_000;
    let tokenA = 0;
    let second: Awaited<ReturnType<typeof runScheduler>> | null = null;
    const lease: Lease = {
      ...inner,
      async acquire(now) {
        const r = await inner.acquire(now);
        if (r.ok && tokenA === 0) tokenA = r.token;
        return r;
      },
      async recordIntent(tok, now, i) {
        const r = await inner.recordIntent(tok, now, i);
        if (tok === tokenA) {
          // The answer is in flight to A while A's lease runs out and the next cron runs B to completion.
          t += 300_000;
          await test.setNextBlockTimestamp({ timestamp: BigInt(nowB) });
          await test.mine({ blocks: 1 });
          second = await runScheduler(env, nowB, { lease, clockMs: () => t });
        }
        return r;
      },
    };
    let first: Awaited<ReturnType<typeof runScheduler>> | null = null;
    const raws = await capture(async () => {
      first = await runScheduler(env, nowA, { lease, clockMs: () => t });
    });
    const b = second as unknown as Awaited<ReturnType<typeof runScheduler>>;
    expect(b.ok && b.scheduled).toEqual([]);
    expect(b.ok && b.skips.some((s) => s.includes('rebroadcast it, nothing new sent'))).toBe(true);
    expect(first).not.toBeNull();
    expect(new Set(raws).size).toBe(1);
    // A rebroadcast is acknowledged before it is mined; wait for the one transaction before reading the rounds.
    await pub.waitForTransactionReceipt({ hash: keccak256(raws[0]), timeout: 10_000 }).catch(() => null);
    const got = await created(before);
    expect(got, got.length ? '' : await whyNotMined(raws[0])).toEqual([{ creator: houseAddr(S1), startTime: S1 }]);
  }, 120_000);

  it('a stall between the record and the send: the same, and A\'s late send is the identical transaction', async () => {
    const { before, S1, nowA, nowB } = await setup(1);
    const lease = memLease();
    let t = 19_000_000;
    let second: Awaited<ReturnType<typeof runScheduler>> | null = null;
    const raws = await capture(async () => {
      await runScheduler(env, nowA, {
        lease,
        clockMs: () => t,
        afterRecord: async () => {
          t += 300_000;
          await test.setNextBlockTimestamp({ timestamp: BigInt(nowB) });
          await test.mine({ blocks: 1 });
          second = await runScheduler(env, nowB, { lease, clockMs: () => t });
        },
      });
    });
    const b = second as unknown as Awaited<ReturnType<typeof runScheduler>>;
    expect(b.ok && b.scheduled).toEqual([]);
    expect(raws.length).toBe(2); // B's rebroadcast and A's late send
    expect(new Set(raws).size).toBe(1);
    // A rebroadcast is acknowledged before it is mined; wait for the one transaction before reading the rounds.
    await pub.waitForTransactionReceipt({ hash: keccak256(raws[0]), timeout: 10_000 }).catch(() => null);
    const got = await created(before);
    expect(got, got.length ? '' : await whyNotMined(raws[0])).toEqual([{ creator: houseAddr(S1), startTime: S1 }]);
  }, 120_000);

  it('a crash after the record: the next run sends that transaction, the run after clears it and books the next slot', async () => {
    const { before, S1, nowA } = await setup(2);
    const lease = memLease();
    let t = 29_000_000;
    await expect(
      runScheduler(env, nowA, {
        lease,
        clockMs: () => t,
        afterRecord: async () => {
          throw new Error('crashed after recording');
        },
      }),
    ).rejects.toThrow('crashed after recording');
    expect(lease.openIntent()?.startTime).toBe(S1);
    expect(await count()).toBe(before);

    t += LEASE_MS; // the lease was released in `finally`; time moves on
    const b = await runScheduler(env, nowA + 60, { lease, clockMs: () => t });
    expect(b.ok && b.skips.some((s) => s.includes('rebroadcast it'))).toBe(true);
    const recordedHash = lease.openIntent()?.hash;
    expect(recordedHash).toBeDefined();
    await pub.waitForTransactionReceipt({ hash: recordedHash as Hex, timeout: 10_000 });
    expect(await created(before)).toEqual([{ creator: houseAddr(S1), startTime: S1 }]);

    t += LEASE_MS;
    const c = await runScheduler(env, nowA + 120, { lease, clockMs: () => t });
    expect(c.ok && c.skips.some((s) => s.includes('landed; cleared'))).toBe(true);
    expect(lease.openIntent()).toBeNull();
  }, 120_000);
});
