// Codex Rounds r1, Part B: two overlapping runs must never both send. Run A is held just before its send while run
// B starts and finishes; then A continues. With the shared lease, B does nothing and exactly one transaction goes
// out. Against the real MakoRoundsV1 on a local fork (anvil), never the live chain; skipped unless both are set:
//   SCHED_ANVIL_RPC=http://127.0.0.1:18546 SCHED_ROUNDS=<deployed> npx vitest run test/concurrency.e2e.test.ts
// (deploy as in anvil.e2e.test.ts, creators [anvil 1, anvil 0]). The keys are anvil's public development keys.
import { createPublicClient, http, parseAbi } from 'viem';
import { describe, expect, it, vi } from 'vitest';

import { runScheduler, type Env } from '../src/index';
import { memLease } from './lease-fake';
import { LEASE_MS } from '../src/state';

const RPC = process.env.SCHED_ANVIL_RPC ?? '';
const ROUNDS = process.env.SCHED_ROUNDS ?? '';

const env: Env = {
  RPC_URL: RPC,
  ROUNDS_ADDRESS: ROUNDS,
  HOUSE_1_ADDRESS: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  HOUSE_2_ADDRESS: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  INTERVAL_S: '7200',
  DRY_RUN: 'false',
  HOUSE_1_PRIVATE_KEY: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  HOUSE_2_PRIVATE_KEY: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
};

describe.skipIf(!RPC || !ROUNDS)('two overlapping runs', () => {
  it('send at most one transaction: the second run finds the lease held and does nothing', async () => {
    const client = createPublicClient({ transport: http(RPC) });
    const abi = parseAbi(['function roundCount() view returns (uint256)']);
    const count = () => client.readContract({ address: ROUNDS as `0x${string}`, abi, functionName: 'roundCount' });
    const before = await count();
    const now = Number((await client.getBlock()).timestamp);

    const realFetch = globalThis.fetch;
    let sends = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (...a: Parameters<typeof fetch>) => {
      if (String(a[1]?.body ?? '').includes('eth_sendRawTransaction')) sends++;
      return realFetch(...a);
    });

    const lease = memLease();
    let second: Awaited<ReturnType<typeof runScheduler>> | null = null;
    const first = await runScheduler(env, now, {
      lease,
      clockMs: () => Date.now(),
      // A has read, planned and simulated; before it signs, B runs to completion.
      beforeSend: async () => {
        second = await runScheduler(env, now, { lease, clockMs: () => Date.now() });
      },
    });
    vi.restoreAllMocks();

    expect(second).toEqual({ ok: true, scheduled: [], skips: ['another run holds the lease; nothing done'] });
    expect(first.ok && first.scheduled).toHaveLength(1);
    expect(sends).toBe(1);
    expect((await count()) - before).toBe(1n);
    expect(lease.held()).toBe(false);
  }, 120_000);

  it('a run past its send deadline sends nothing', async () => {
    const client = createPublicClient({ transport: http(RPC) });
    const now = Number((await client.getBlock()).timestamp);
    let t = 1_000_000;
    const res = await runScheduler(env, now, {
      lease: memLease(),
      clockMs: () => t,
      beforeSend: async () => {
        t += 180_001;
      },
    });
    expect(res.ok && res.scheduled).toEqual([]);
    expect(res.ok && res.skips.some((s) => s.includes('run too slow'))).toBe(true);
  }, 120_000);

  it('a run whose reads stall past its lease sends nothing, while the run that took the lease over sends once (Codex Rounds r2)', async () => {
    const client = createPublicClient({ transport: http(RPC) });
    const abi = parseAbi(['function roundCount() view returns (uint256)']);
    const count = () => client.readContract({ address: ROUNDS as `0x${string}`, abi, functionName: 'roundCount' });
    const before = await count();
    const now = Number((await client.getBlock()).timestamp);

    const realFetch = globalThis.fetch;
    let sends = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (...a: Parameters<typeof fetch>) => {
      if (String(a[1]?.body ?? '').includes('eth_sendRawTransaction')) sends++;
      return realFetch(...a);
    });

    const lease = memLease();
    let t = 5_000_000;
    let second: Awaited<ReturnType<typeof runScheduler>> | null = null;
    const first = await runScheduler(env, now, {
      lease,
      clockMs: () => t,
      // A has read its nonces, gas and fees; they "returned" after its lease expired. B takes the lease over and
      // schedules the same slot before A goes on.
      beforeSend: async () => {
        t += LEASE_MS + 1;
        second = await runScheduler(env, now, { lease, clockMs: () => t });
      },
    });
    vi.restoreAllMocks();

    expect(second).not.toBeNull();
    const b = second as unknown as Awaited<ReturnType<typeof runScheduler>>;
    expect(b.ok && b.scheduled).toHaveLength(1);
    expect(first.ok && first.scheduled).toEqual([]);
    expect(first.ok && first.skips.some((s) => s.includes('lease lost'))).toBe(true);
    expect(sends).toBe(1);
    expect((await count()) - before).toBe(1n);
  }, 120_000);
});
