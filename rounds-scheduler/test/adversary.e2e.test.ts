// Adversary attacks on the scheduler, end to end against the real MakoRoundsV1 bytecode on a local fork of Monad
// testnet (anvil), never the live chain. Skipped unless both variables are set:
//   anvil --fork-url https://testnet-rpc.monad.xyz/ --network monad --port 18617
//   forge create src/MakoRoundsV1.sol:MakoRoundsV1 ... --constructor-args <treasury> <usdc> \
//     "[0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC,0x70997970C51812dc3A010C7d01b50e0d17dc79C8,0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266]"
//   ADV_ANVIL_RPC=http://127.0.0.1:18617 ADV_ROUNDS=<deployed> npx vitest run test/adversary.e2e.test.ts
// Creators are anvil dev accounts 2 (a third, non-house creator), 1 (house 1) and 0 (house 2). The keys are anvil's
// published development keys, which exist only on local test chains.
import { createPublicClient, createTestClient, createWalletClient, http, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mined } from './mined';
import worker, { runScheduler, type Env } from '../src/index';
import { deps, memLease, memNamespace } from './lease-fake';

const RPC = process.env.ADV_ANVIL_RPC ?? '';
const URL_OR_UNUSED = RPC || 'http://127.0.0.1:1'; // clients are built at collection time even when the suite is skipped
const ROUNDS = (process.env.ADV_ROUNDS ?? '') as `0x${string}`;
const H = 7200;

const KEY_HOUSE_1 = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex; // anvil 1
const KEY_HOUSE_2 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex; // anvil 0
const KEY_THIRD = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as Hex; // anvil 2

const env: Env = {
  RPC_URL: RPC,
  ROUNDS_ADDRESS: ROUNDS,
  HOUSE_1_ADDRESS: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  HOUSE_2_ADDRESS: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  INTERVAL_S: String(H),
  DRY_RUN: 'false',
  HOUSE_1_PRIVATE_KEY: KEY_HOUSE_1,
  HOUSE_2_PRIVATE_KEY: KEY_HOUSE_2,
};

const abi = parseAbi([
  'function roundCount() view returns (uint256)',
  'function phaseOf(uint256) view returns (uint8)',
  'function schedule(uint64 startTime) returns (uint256)',
  'function finalizeRefund(uint256 roundId)',
  'function roundOf(uint256) view returns ((address creator, uint64 openTime, uint64 startTime, uint8 status, uint8 outcome, uint8 refundReason, int192 anchorPrice, int192 closePrice, uint32 anchorObservedAt, uint32 closeObservedAt, bytes32 anchorReportHash, bytes32 closeReportHash, uint256 upPool, uint256 downPool, uint32 upEntrants, uint32 downEntrants, uint256 protocolFee, uint256 creatorFee, uint256 distributable, uint32 winnersClaimed, uint256 paidOut))',
]);

describe.skipIf(!RPC || !ROUNDS)('scheduler adversary on a local fork', () => {
  const pub = createPublicClient({ transport: http(URL_OR_UNUSED) });
  const test = createTestClient({ mode: 'anvil', transport: http(URL_OR_UNUSED) });
  const send = async (key: Hex, functionName: 'schedule' | 'finalizeRefund', arg: bigint) => {
    const w = createWalletClient({ account: privateKeyToAccount(key), transport: http(URL_OR_UNUSED) });
    const hash = await w.writeContract({ address: ROUNDS, abi, functionName, args: [arg], chain: null });
    const r = await pub.waitForTransactionReceipt({ hash });
    expect(r.status).toBe('success');
  };
  const chainNow = async () => Number((await pub.getBlock()).timestamp);
  const roundCount = () => pub.readContract({ address: ROUNDS, abi, functionName: 'roundCount' });
  const unfinishedAt = async (start: number) => {
    let n = 0;
    for (let id = 1n; id <= (await roundCount()); id++) {
      const r = await pub.readContract({ address: ROUNDS, abi, functionName: 'roundOf', args: [id] });
      const phase = await pub.readContract({ address: ROUNDS, abi, functionName: 'phaseOf', args: [id] });
      if (Number(r.startTime) === start && phase !== 4 && phase !== 5) n++;
    }
    return n;
  };

  let snap: Hex;
  beforeEach(async () => {
    snap = await test.snapshot();
  });
  afterEach(async () => {
    await test.revert({ id: snap });
    vi.restoreAllMocks();
  });

  it('never schedules a slot that already holds an unfinished round, even one more than a scan page (40) back', async () => {
    // A third creator books a 2-hour slot two days out, which the spec says the scheduler must leave alone.
    const t0 = (await chainNow()) + 1;
    const S = Math.ceil((t0 + 2 * 86_400) / H) * H;
    await test.setNextBlockTimestamp({ timestamp: BigInt(t0) });
    await send(KEY_THIRD, 'schedule', BigInt(S));

    // Ordinary traffic in the meantime: 85 short rounds (more than two scan pages since the fix), each scheduled at the minimum lead and refunded one-sided
    // once entries close. Two days of 2-hour house rounds alone is 24 rounds, so this is a normal week, not an exotic one.
    for (let i = 0; i < 85; i++) {
      const at = (await chainNow()) + 1;
      const start = Math.ceil((at + 600) / 60) * 60;
      await test.setNextBlockTimestamp({ timestamp: BigInt(at) });
      await send(KEY_HOUSE_1, 'schedule', BigInt(start));
      await test.setNextBlockTimestamp({ timestamp: BigInt(start - 60) });
      await send(KEY_HOUSE_1, 'finalizeRefund', await roundCount());
    }
    expect(await unfinishedAt(S)).toBe(1);

    // An hour before S, S is the first upcoming slot.
    await test.setNextBlockTimestamp({ timestamp: BigInt(S - 3600) });
    await test.mine({ blocks: 1 });
    const res = await runScheduler(env, await chainNow(), deps());
    expect(res.ok).toBe(true);
    await mined(pub, res);

    // The third creator's round is still the only unfinished round at S.
    expect(await unfinishedAt(S)).toBe(1);
  }, 300_000);

  it('sends nothing when DRY_RUN is " false" (not exactly "false")', async () => {
    const before = await roundCount();
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s: string) => void logs.push(s));
    const now = await chainNow();
    await worker.scheduled({ scheduledTime: now * 1000, cron: '*/5 * * * *', noRetry() {} } as ScheduledController, {
      ...env,
      DRY_RUN: ' false',
      SCHEDULER_STATE: memNamespace(memLease()),
    });
    // The run itself happened (a plan was made), so the absence of a send is the dry run, not a missing binding.
    expect(logs[0]).toContain('"ok":true');
    const after = await roundCount();
    // Spec: never send anything when DRY_RUN is not exactly "false".
    expect({ sent: after - before, log: logs[0] }).toEqual({ sent: 0n, log: logs[0] });
  }, 120_000);

  // Since the fix the scheduler sends at most one round per run, so a run that sends is the heaviest one.
  it('fits a run that sends inside the Worker subrequest limit of 20 (wrangler.toml [limits])', async () => {
    const realFetch = globalThis.fetch;
    let n = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((...a: Parameters<typeof fetch>) => {
      n++;
      return realFetch(...a);
    });
    const res = await runScheduler(env, await chainNow(), deps());
    expect(res.ok && res.scheduled.length).toBe(1);
    console.info(`subrequests for a run that sends: ${n}`);
    expect(n).toBeLessThanOrEqual(20);
  }, 120_000);
});
