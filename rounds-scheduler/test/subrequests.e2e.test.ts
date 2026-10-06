// Spec 4 (adversary on 3f08d05): the Worker's subrequest count per run stays bounded, under wrangler.toml's
// `[limits] subrequests` and under WORST_CASE_SUBREQUESTS (src/index.ts). Every fetch to the RPC and every call to the SchedulerState Durable Object is a subrequest. This counts both
// over ONE run, on a local anvil fork that mines on a 0.4 s timer the way Monad does (a transaction is not in a block
// the instant it is acknowledged), never the live chain. Skipped unless both are set:
//   anvil --fork-url https://testnet-rpc.monad.xyz/ --network monad --port <p> --block-time 0.4
//   forge create src/MakoRoundsV1.sol:MakoRoundsV1 ... --constructor-args <treasury> <usdc> "[<anvil 1>,<anvil 0>]"
//   SUB_ANVIL_RPC=http://127.0.0.1:<p> SUB_ROUNDS=<deployed> npx vitest run test/subrequests.e2e.test.ts
// One fresh fork per run of this file: it books two rounds. The keys are anvil's published development keys.
import { createPublicClient, http } from 'viem';
import { describe, expect, it, vi } from 'vitest';

import { runScheduler, WORST_CASE_SUBREQUESTS, type Env, type Lease } from '../src/index';
import { LEASE_MS } from '../src/state';
import { memLease } from './lease-fake';
import wranglerToml from '../wrangler.toml?raw';

const RPC = process.env.SUB_ANVIL_RPC ?? '';
const ROUNDS = process.env.SUB_ROUNDS ?? '';
const H = 7200;
/// wrangler.toml [limits] subrequests: Cloudflare counts every fetch AND every call to a Cloudflare service (the
/// Durable Object here) against it (developers.cloudflare.com/workers/platform/limits/#subrequests, read 2026-10-06).
const LIMIT = Number(/^subrequests\s*=\s*(\d+)/m.exec(wranglerToml)?.[1]);

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

describe.skipIf(!RPC || !ROUNDS)('subrequests in one run', () => {
  it('reads the limit from wrangler.toml', () => expect(LIMIT).toBeGreaterThan(0));

  it('the computed worst case fits the limit', () => expect(WORST_CASE_SUBREQUESTS).toBeLessThanOrEqual(LIMIT));

  it('every run on each path stays within the computed worst case and the limit', async () => {
    const pub = createPublicClient({ transport: http(RPC) });
    const now = Number((await pub.getBlock()).timestamp);
    const inner = memLease();
    let t = 1_000_000;

    /// One run, counted: every Durable Object call and every fetch.
    async function counted(nowS: number, extra: Partial<Parameters<typeof runScheduler>[2]> = {}) {
      const doCalls: string[] = [];
      const lease: Lease = {
        acquire: (n) => (doCalls.push('acquire'), inner.acquire(n)),
        release: (k) => (doCalls.push('release'), inner.release(k)),
        intent: (k, n) => (doCalls.push('intent'), inner.intent(k, n)),
        recordIntent: (k, n, i) => (doCalls.push('recordIntent'), inner.recordIntent(k, n, i)),
        clearIntent: (k, n, h) => (doCalls.push('clearIntent'), inner.clearIntent(k, n, h)),
      };
      const realFetch = globalThis.fetch;
      const fetches: string[] = [];
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (...a: Parameters<typeof fetch>) => {
        const calls = [JSON.parse(String(a[1]?.body ?? '{}'))].flat() as { method: string }[];
        fetches.push(calls.map((c) => c.method).join('+'));
        return realFetch(...a);
      });
      let result;
      try {
        result = await runScheduler(env, nowS, { lease, clockMs: () => t, ...extra });
      } finally {
        vi.restoreAllMocks();
      }
      const byMethod: Record<string, number> = {};
      for (const m of [...fetches, ...doCalls.map((d) => `DO.${d}`)]) byMethod[m] = (byMethod[m] ?? 0) + 1;
      const total = fetches.length + doCalls.length;
      const why = `${fetches.length} fetches + ${doCalls.length} Durable Object calls: ${JSON.stringify(byMethod)}`;
      expect(total, why).toBeLessThanOrEqual(WORST_CASE_SUBREQUESTS);
      expect(total, why).toBeLessThanOrEqual(LIMIT);
      return result;
    }

    // Plan and send; its lease runs out after the record, so the intent stays open.
    const first = await counted(now, { afterRecord: async () => void (t += LEASE_MS + 1) });
    expect(first.ok && first.scheduled).toHaveLength(1);
    const hash = inner.openIntent()?.hash;
    expect(hash, 'run 1 left its intent open').toBeDefined();
    await pub.waitForTransactionReceipt({ hash: hash as `0x${string}`, timeout: 10_000 });

    // The next run clears it, and only that.
    t += 300_000;
    const second = await counted(now + 300);
    expect(second.ok && second.skips.some((s) => s.includes('cleared, the next run plans'))).toBe(true);
    expect(second.ok && second.scheduled).toEqual([]);
    expect(inner.openIntent()).toBeNull();

    // The run after books the other house's slot.
    t += 300_000;
    const third = await counted(now + 600);
    expect(third.ok && third.scheduled).toHaveLength(1);
  }, 120_000);
});
