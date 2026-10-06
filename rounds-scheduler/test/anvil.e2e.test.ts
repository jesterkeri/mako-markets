// End to end against the real MakoRoundsV1 bytecode on a local fork of Monad testnet (anvil), never the live chain.
// Skipped unless both variables are set:
//   anvil --fork-url https://testnet-rpc.monad.xyz/ --network monad --port 18546
//   forge create src/MakoRoundsV1.sol:MakoRoundsV1 ... --constructor-args <treasury> <usdc> "[<anvil 1>,<anvil 0>]"
//   SCHED_ANVIL_RPC=http://127.0.0.1:18546 SCHED_ROUNDS=<deployed> npx vitest run test/anvil.e2e.test.ts
// The keys are anvil's published development keys, which exist only on local test chains.
import { createPublicClient, http, parseAbi } from 'viem';
import { describe, expect, it } from 'vitest';

import { runScheduler, type Env } from '../src/index';
import { houseOf } from '../src/plan';

const RPC = process.env.SCHED_ANVIL_RPC ?? '';
const ROUNDS = process.env.SCHED_ROUNDS ?? '';
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

describe.skipIf(!RPC || !ROUNDS)('scheduler on a local fork with the real contract', () => {
  it('fills the next two slots from alternating houses, one per run, then nothing more', async () => {
    const client = createPublicClient({ transport: http(RPC) });
    const abi = parseAbi([
      'function roundCount() view returns (uint256)',
      'function roundOf(uint256) view returns ((address creator, uint64 openTime, uint64 startTime, uint8 status, uint8 outcome, uint8 refundReason, int192 anchorPrice, int192 closePrice, uint32 anchorObservedAt, uint32 closeObservedAt, bytes32 anchorReportHash, bytes32 closeReportHash, uint256 upPool, uint256 downPool, uint32 upEntrants, uint32 downEntrants, uint256 protocolFee, uint256 creatorFee, uint256 distributable, uint32 winnersClaimed, uint256 paidOut))',
    ]);
    const now = Number((await client.getBlock()).timestamp);
    const before = await client.readContract({ address: ROUNDS as `0x${string}`, abi, functionName: 'roundCount' });

    // One round per run (the cron runs every 5 minutes): two runs fill the next two slots.
    const first = await runScheduler(env, now);
    expect(first.ok && first.scheduled).toHaveLength(1);
    const firstAgain = await runScheduler(env, now + 10);
    expect(firstAgain.ok && firstAgain.scheduled).toHaveLength(1);
    const after = await client.readContract({ address: ROUNDS as `0x${string}`, abi, functionName: 'roundCount' });
    expect(after - before).toBe(2n);

    const houses = [env.HOUSE_1_ADDRESS.toLowerCase(), env.HOUSE_2_ADDRESS.toLowerCase()];
    for (let id = before + 1n; id <= after; id++) {
      const r = await client.readContract({ address: ROUNDS as `0x${string}`, abi, functionName: 'roundOf', args: [id] });
      const start = Number(r.startTime);
      expect(start % H).toBe(0);
      expect(start - now).toBeGreaterThanOrEqual(600);
      // The slot's own house created it.
      expect(r.creator.toLowerCase()).toBe(houses[houseOf(start, H)]);
    }

    const second = await runScheduler(env, now + 30);
    expect(second.ok && second.scheduled).toEqual([]);
    expect(await client.readContract({ address: ROUNDS as `0x${string}`, abi, functionName: 'roundCount' })).toBe(after);
  }, 120_000);
});
