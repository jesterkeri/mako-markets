// mako-rounds-scheduler: keeps Mako's own BTC rounds on the calendar. Every 5 minutes it reads MakoRoundsV1, decides
// with planSchedule (src/plan.ts) whether an upcoming slot needs a round, and if so has that slot's house creator
// call `schedule`. It holds the two house creator keys and nothing else; it never enters, settles, refunds or moves
// USDC. Every rule it applies the contract enforces again, so a mistake here can at worst waste gas on a refusal.

import { createPublicClient, createWalletClient, defineChain, getAddress, http, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { planSchedule, type ChainView, type HouseView } from './plan';

export interface Env {
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

const ROUNDS_ABI = parseAbi([
  'function creatorActiveRound(address) view returns (uint256)',
  'function activeRoundCount() view returns (uint256)',
  'function MAX_ACTIVE_ROUNDS() view returns (uint256)',
  'function isCreator(address) view returns (bool)',
  'function roundCount() view returns (uint256)',
  'function phaseOf(uint256) view returns (uint8)',
  'function roundOf(uint256) view returns ((address creator, uint64 openTime, uint64 startTime, uint8 status, uint8 outcome, uint8 refundReason, int192 anchorPrice, int192 closePrice, uint32 anchorObservedAt, uint32 closeObservedAt, bytes32 anchorReportHash, bytes32 closeReportHash, uint256 upPool, uint256 downPool, uint32 upEntrants, uint32 downEntrants, uint256 protocolFee, uint256 creatorFee, uint256 distributable, uint32 winnersClaimed, uint256 paidOut))',
  'function schedule(uint64 startTime) returns (uint256)',
]);

/// Unfinished rounds the contract can hold at once is small (MAX_ACTIVE_ROUNDS), so the newest rounds cover them.
const SCAN = 24n;

const monad = defineChain({
  id: 10143,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: ['https://testnet-rpc.monad.xyz/'] } },
  contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
});

export type RunResult = { ok: true; scheduled: { house: number; startTime: number; tx?: Hex }[]; skips: string[] } | { ok: false; error: string };

export async function runScheduler(env: Env, nowS: number): Promise<RunResult> {
  const rounds = getAddress(env.ROUNDS_ADDRESS.trim());
  const houses = [getAddress(env.HOUSE_1_ADDRESS.trim()), getAddress(env.HOUSE_2_ADDRESS.trim())] as const;
  const intervalS = Number(env.INTERVAL_S);
  const dryRun = env.DRY_RUN.trim() !== 'false';
  const client = createPublicClient({ chain: monad, transport: http(env.RPC_URL.trim()), batch: { multicall: true } });
  const c = { address: rounds, abi: ROUNDS_ABI } as const;

  // One Multicall3 call: both houses' unfinished rounds, the count, the cap, and that both are still creators.
  const [a1, a2, count, cap, isC1, isC2, total] = await client.multicall({
    allowFailure: false,
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

  // The newest rounds, for start times already taken by anyone and the houses' own start times.
  const ids: bigint[] = [];
  for (let id = total; id >= 1n && ids.length < Number(SCAN); id--) ids.push(id);
  const reads = ids.length
    ? await client.multicall({
        allowFailure: false,
        contracts: ids.flatMap((id) => [
          { ...c, functionName: 'roundOf', args: [id] },
          { ...c, functionName: 'phaseOf', args: [id] },
        ]),
      })
    : [];
  const startOf = new Map<bigint, number>();
  const scheduledStarts: number[] = [];
  ids.forEach((id, i) => {
    const r = reads[2 * i] as unknown as { startTime: bigint };
    const phase = Number(reads[2 * i + 1]);
    startOf.set(id, Number(r.startTime));
    // Phase 4 Settled, 5 Refunded: finished; anything else is unfinished.
    if (phase !== 4 && phase !== 5) scheduledStarts.push(Number(r.startTime));
  });
  const house = (addr: `0x${string}`, active: bigint): HouseView => ({ address: addr, activeRoundId: active, activeStart: active === 0n ? null : (startOf.get(active) ?? null) });
  const view: ChainView = {
    nowS,
    houses: [house(houses[0], a1 as bigint), house(houses[1], a2 as bigint)],
    activeRoundCount: count as bigint,
    maxActiveRounds: cap as bigint,
    scheduledStarts,
  };
  const plan = planSchedule(view, intervalS);
  const skips = plan.skips.map((s) => `${new Date(s.slot * 1000).toISOString()} ${s.reason}`);

  const keys = [env.HOUSE_1_PRIVATE_KEY, env.HOUSE_2_PRIVATE_KEY];
  const scheduled: { house: number; startTime: number; tx?: Hex }[] = [];
  for (const a of plan.actions) {
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
    const wallet = createWalletClient({ account, chain: monad, transport: http(env.RPC_URL.trim()) });
    const tx = await wallet.writeContract({ ...c, functionName: 'schedule', args: [BigInt(a.startTime)] });
    // Wait for it (Monad blocks are under a second), so the next run sees the round and never sends a duplicate the
    // contract would refuse. A timeout is reported; the next run re-reads the chain either way.
    const receipt = await client.waitForTransactionReceipt({ hash: tx, timeout: 30_000 }).catch(() => null);
    if (!receipt) skips.push(`${new Date(a.startTime * 1000).toISOString()} sent ${tx}, receipt not seen within 30s`);
    else if (receipt.status !== 'success') skips.push(`${new Date(a.startTime * 1000).toISOString()} sent ${tx}, reverted`);
    scheduled.push({ house: a.house + 1, startTime: a.startTime, tx });
  }
  return { ok: true, scheduled, skips };
}

export default {
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    let result: RunResult;
    try {
      result = await runScheduler(env, Math.floor(event.scheduledTime / 1000));
    } catch (err) {
      // Reported by kind only: an error's text could carry the RPC URL.
      result = { ok: false, error: (err as Error)?.name ?? 'error' };
    }
    console.log(JSON.stringify({ scheduler: result, dryRun: env.DRY_RUN !== 'false', cron: event.scheduledTime }));
  },
};
