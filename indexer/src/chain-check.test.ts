// The indexer over the REAL chain, checked against the contract itself. It replays every MakoMarketsV4 event from
// the deployment block to a recent finalized block through HyperSync, then reads every market's state from the
// contract at that same block and requires the indexed pool to match it field for field.
//
// Needs ENVIO_API_TOKEN (indexer/.env, never committed). Without it, as in CI, the test is skipped.

import { existsSync } from 'node:fs';
import { describe, it } from 'vitest';
import { createTestIndexer } from 'envio';
import { createPublicClient, defineChain, http, parseAbi } from 'viem';

import { isInternal } from './internal-wallets';


if (!process.env.ENVIO_API_TOKEN && existsSync('.env')) process.loadEnvFile('.env');

const MAKO = '0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195';
const START_BLOCK = 32_603_678;
const RPC = 'https://testnet-rpc.monad.xyz';

const monad = defineChain({
  id: 10143,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
  contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11', blockCreated: 0 } },
});

const abi = parseAbi([
  'function nextMarketId() view returns (uint256)',
  'function getMarket(uint256 id) view returns ((address creator, uint8 mType, bytes32 oracleRef, string question, uint64 createdAt, uint64 closeTime, uint64 bettingCloseTime, uint256 totalYes, uint256 totalNo, uint32 yesBettorCount, uint32 noBettorCount, uint8 outcome, bool resolved, bool creatorFeeClaimed, uint16 protocolFeeBpsSnapshot, uint16 creatorFeeBpsSnapshot))',
]);

const CATEGORY = ['Football', 'Crypto', 'Basketball', 'Forex', 'Commodities', 'Stocks', 'Mako'];
const STATUS = (resolved: boolean, outcome: number) => (!resolved ? 'Open' : outcome === 1 ? 'Yes' : outcome === 2 ? 'No' : 'Refund');

describe.skipIf(!process.env.ENVIO_API_TOKEN)('the indexer against Monad testnet', () => {
  it(
    'matches the contract for every pool, at the same block',
    async (t) => {
      const client = createPublicClient({ chain: monad, transport: http(RPC, { batch: false, retryCount: 3 }) });
      const finalized = await client.getBlock({ blockTag: 'finalized' });
      const endBlock = Number(finalized.number);

      const indexer = createTestIndexer();
      const started = Date.now();
      await indexer.process({ chains: { 10143: { startBlock: START_BLOCK, endBlock } } });
      const seconds = ((Date.now() - started) / 1000).toFixed(1);

      const at = { blockNumber: BigInt(endBlock) };
      const count = Number(await client.readContract({ address: MAKO, abi, functionName: 'nextMarketId', ...at }));
      const ids = Array.from({ length: count }, (_, i) => BigInt(i));
      const markets = await client.multicall({
        contracts: ids.map((id) => ({ address: MAKO as `0x${string}`, abi, functionName: 'getMarket' as const, args: [id] as const })),
        allowFailure: false,
        batchSize: 2048,
        ...at,
      });

      const mismatches: string[] = [];
      for (const [i, m] of markets.entries()) {
        const pool = await indexer.Pool.get(String(i));
        if (!pool) {
          mismatches.push(`pool ${i}: not indexed`);
          continue;
        }
        const want = {
          creator_id: m.creator.toLowerCase(),
          category: CATEGORY[m.mType],
          totalYes: m.totalYes,
          totalNo: m.totalNo,
          yesBettors: m.yesBettorCount,
          noBettors: m.noBettorCount,
          status: STATUS(m.resolved, m.outcome),
          closeTime: m.closeTime,
          question: m.question,
        };
        for (const [k, v] of Object.entries(want)) {
          const got = (pool as Record<string, unknown>)[k];
          if (got !== v) mismatches.push(`pool ${i} ${k}: indexed ${String(got)}, contract ${String(v)}`);
        }
      }

      const global = await indexer.GlobalStats.get('global');
      console.log(
        `[chain-check] blocks ${START_BLOCK}..${endBlock} in ${seconds}s; ${count} markets on chain; indexed:`,
        JSON.stringify(global, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
      );
      t.expect(mismatches, mismatches.slice(0, 20).join('\n')).toEqual([]);
      t.expect(global?.pools).toBe(count);
      // The public figures, recomputed from the contract with the same reviewed internal-wallet list (Codex S6 r2).
      const publicPools = markets.filter((m) => !isInternal(m.creator));
      t.expect(global?.communityPools).toBe(publicPools.length);
      t.expect(global?.communityPoolsSettled).toBe(publicPools.filter((m) => m.resolved).length);
      t.expect(global?.communityPoolsRefunded).toBe(publicPools.filter((m) => m.resolved && m.outcome === 3).length);
    },
    20 * 60_000,
  );
});
