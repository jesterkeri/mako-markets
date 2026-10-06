// Adversary on 55fd16a: the lease confirm is itself a Durable Object RPC with no bound on how long its answer takes,
// and nothing re-checks the clock once it returns. Run A's confirm is answered ok, the answer reaches A only after
// its lease expired and run B (the next cron, 5 minutes later) took the lease over and sent; then A signs and sends.
// Spec: two invocations must never both broadcast a schedule transaction that can execute, and a run must own a
// valid lease at its broadcast point. Here B moved to the next slot, which belongs to the other house, so the nonce
// A pinned does not fence it and both transactions execute.
// Against the real MakoRoundsV1 on a local fork (anvil), never the live chain; skipped unless both are set:
//   SCHED_ANVIL_RPC=http://127.0.0.1:18746 SCHED_ROUNDS=<deployed> npx vitest run test/confirm-stall.e2e.test.ts
// (deploy as in anvil.e2e.test.ts, creators [anvil 1, anvil 0]). The keys are anvil's public development keys.
import { createPublicClient, createTestClient, http, parseAbi } from 'viem';
import { describe, expect, it, vi } from 'vitest';

import { runScheduler, type Env, type Lease } from '../src/index';
import { memLease } from './lease-fake';
import { houseOf } from '../src/plan';

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

describe.skipIf(!RPC || !ROUNDS)('a run whose lease confirm answers late', () => {
  it('does not broadcast after another run took the lease over', async () => {
    const pub = createPublicClient({ transport: http(URL_OR_UNUSED) });
    const test = createTestClient({ mode: 'anvil', transport: http(URL_OR_UNUSED) });
    const abi = parseAbi([
      'function roundCount() view returns (uint256)',
      'function roundOf(uint256) view returns ((address creator, uint64 openTime, uint64 startTime, uint8 status, uint8 outcome, uint8 refundReason, int192 anchorPrice, int192 closePrice, uint32 anchorObservedAt, uint32 closeObservedAt, bytes32 anchorReportHash, bytes32 closeReportHash, uint256 upPool, uint256 downPool, uint32 upEntrants, uint32 downEntrants, uint256 protocolFee, uint256 creatorFee, uint256 distributable, uint32 winnersClaimed, uint256 paidOut))',
    ]);
    const count = () => pub.readContract({ address: ROUNDS as `0x${string}`, abi, functionName: 'roundCount' });
    const before = await count();

    // Run A fires 1000 s before slot S1 (lead 1000 s, so S1 is its first upcoming slot); run B is the next cron,
    // 300 s later, when S1 is inside the 780 s lead floor and B's first slot is S2 = S1 + 2h, the other house's.
    const c = Number((await pub.getBlock()).timestamp);
    const S1 = Math.ceil((c + 1100) / H) * H;
    const nowA = S1 - 1000;
    const nowB = nowA + 300;
    await test.setNextBlockTimestamp({ timestamp: BigInt(nowA) });
    await test.mine({ blocks: 1 });

    // Who holds the lease at the moment each eth_sendRawTransaction leaves.
    const inner = memLease();
    let holder = 0;
    let t = 9_000_000;
    let second: Awaited<ReturnType<typeof runScheduler>> | null = null;
    let tokenA = 0;
    const lease: Lease = {
      async acquire(now) {
        const r = await inner.acquire(now);
        if (r.ok) holder = r.token;
        if (r.ok && tokenA === 0) tokenA = r.token;
        return r;
      },
      release: (tok) => inner.release(tok),
      async confirm(tok, now) {
        const r = await inner.confirm(tok, now);
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

    const realFetch = globalThis.fetch;
    const sendsByHolder: number[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (...a: Parameters<typeof fetch>) => {
      if (String(a[1]?.body ?? '').includes('eth_sendRawTransaction')) sendsByHolder.push(holder);
      return realFetch(...a);
    });

    const first = await runScheduler(env, nowA, { lease, clockMs: () => t });
    vi.restoreAllMocks();

    const b = second as unknown as Awaited<ReturnType<typeof runScheduler>>;
    expect(b.ok && b.scheduled.map((s) => s.startTime)).toEqual([S1 + H]);
    const created: { creator: string; startTime: number }[] = [];
    for (let id = before + 1n; id <= (await count()); id++) {
      const r = await pub.readContract({ address: ROUNDS as `0x${string}`, abi, functionName: 'roundOf', args: [id] });
      created.push({ creator: r.creator, startTime: Number(r.startTime) });
    }
    // Spec 1 and 2: A's lease was taken over (token 2 is B's), so A must send nothing and only B's round may exist.
    expect({ aResult: first, sendsByHolder, created }).toEqual({
      aResult: first,
      sendsByHolder: [2],
      created: [{ creator: houseOf(S1 + H, H) === 0 ? env.HOUSE_1_ADDRESS : env.HOUSE_2_ADDRESS, startTime: S1 + H }],
    });
  }, 120_000);
});
