// #214 S1 adversary: what the cron route answers when a scan fails on an RPC error.
//
// Contract (NOTIFICATIONS_PLAN r8):
//   §4 "Nothing private in public responses. Cron responses and logs hold counts only. [r6] The account-address list
//      read by the roster rule stays on the server: it is never logged or returned, and only rosterFromChain (a count)
//      is reported."
//   §3.9 notify-tick.mjs "prints the HTTP status and the JSON counts, and never prints a secret" (it prints each
//      scan's `error`).
//
// Setup: the real /api/cron/notify route, the real V4 scan and the real gated scan client, on pglite with every
// migration. Only `fetch` is stubbed: it answers eth_blockNumber, eth_getLogs (one MarketResolved above the floor),
// eth_getBlockByHash and the getMarket multicall with data encoded by viem from the app's own ABI, and answers the
// roster's getUserBet multicall with HTTP 503 (a transient outage, retried twice, then the batch fails, as §3.2
// requires). MONAD_RPC_URL holds a planted sentinel key in its path, the way a keyed provider URL does. No network.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  multicall3Abi,
  parseAbiItem,
  type Hex,
} from 'viem';

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/db/client', () => ({
  get db() {
    return state.db;
  },
}));

import { makoAbi } from '@/lib/MakoMarkets.abi';
import { LEADERBOARD_CONTRACTS } from '@/lib/leaderboard/contracts';
import { GET as notifyTick } from '../../../app/api/cron/notify/route';

import { createNotifyDb, hex32, setCursor, walletAccount } from './harness';

const SECRET = 'test-cron-secret-0123456789';
const SENTINEL_KEY = 'SENTINELKEYadversary0000000000';
const RPC_URL = `https://rpc.example/v2/${SENTINEL_KEY}`;
const F = 1_000; // NOTIFY_FROM_BLOCK
const HEAD = 1_216;
const POOL = 5n;
const ALICE = '0xa11ce00000000000000000000000000000000001';
const CREATOR = '0xc4ea7040000000000000000000000000000000c1';
const V4 = LEADERBOARD_CONTRACTS[0].address;

const MARKET_RESOLVED = parseAbiItem('event MarketResolved(uint256 indexed id, uint8 outcome)');

const rpcOk = (id: number, result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { status: 200 });

/// A one-sided pool (Alice's YES only, placed below the floor so the ledger never saw it), refunded at F + 10.
function stubChain() {
  const resolvedBlock = F + 10;
  const blockHash = hex32(resolvedBlock);
  const log = {
    address: V4,
    topics: encodeEventTopics({ abi: [MARKET_RESOLVED], eventName: 'MarketResolved', args: { id: POOL } }),
    data: encodeAbiParameters([{ type: 'uint8' }], [3]),
    blockNumber: `0x${resolvedBlock.toString(16)}`,
    blockHash,
    transactionHash: hex32(0xabc),
    transactionIndex: '0x0',
    logIndex: '0x0',
    removed: false,
  };
  const market = {
    creator: CREATOR as Hex,
    mType: 0,
    oracleRef: hex32(0),
    question: 'q',
    createdAt: 1n,
    closeTime: 2n,
    bettingCloseTime: 2n,
    totalYes: 1_000_000n,
    totalNo: 0n,
    yesBettorCount: 1,
    noBettorCount: 0,
    outcome: 3,
    resolved: true,
    creatorFeeClaimed: false,
    protocolFeeBpsSnapshot: 100,
    creatorFeeBpsSnapshot: 200,
  };
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { id: number; method: string; params: unknown[] };
    switch (body.method) {
      case 'eth_blockNumber':
        return rpcOk(body.id, `0x${HEAD.toString(16)}`);
      case 'eth_getLogs': {
        const p = body.params[0] as { fromBlock: Hex; toBlock: Hex };
        const inRange = Number(p.fromBlock) <= resolvedBlock && resolvedBlock <= Number(p.toBlock);
        return rpcOk(body.id, inRange ? [log] : []);
      }
      case 'eth_getBlockByHash':
        return rpcOk(body.id, {
          number: `0x${resolvedBlock.toString(16)}`,
          hash: blockHash,
          parentHash: hex32(resolvedBlock - 1),
          timestamp: '0x6a000000',
          transactions: [],
        });
      case 'eth_call': {
        const call = body.params[0] as { data: Hex };
        const { args } = decodeFunctionData({ abi: multicall3Abi, data: call.data });
        const inner = (args[0] as readonly { callData: Hex }[]).map((c) => decodeFunctionData({ abi: makoAbi, data: c.callData }));
        if (inner[0].functionName === 'getUserBet') return new Response('upstream unavailable', { status: 503 });
        const returnData = encodeFunctionResult({ abi: makoAbi, functionName: 'getMarket', result: market as never });
        return rpcOk(
          body.id,
          encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: inner.map(() => ({ success: true, returnData })) }),
        );
      }
      default:
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'not stubbed' } }), { status: 200 });
    }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('adversary: the cron answer after a failed roster read', () => {
  it('holds counts only: no RPC key and no account address in the JSON the tick script prints', async () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    vi.stubEnv('MONAD_RPC_URL', RPC_URL);
    vi.stubEnv('NOTIFY_FROM_BLOCK', String(F));
    const t = await createNotifyDb();
    state.db = t.db;
    await setCursor(t, V4, F - 1);
    await walletAccount(t, ALICE); // an account, so the roster rule asks the contract for her position
    stubChain();

    const res = await notifyTick(new Request('http://x/api/cron/notify', { headers: { authorization: `Bearer ${SECRET}` } }));
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as { v4: { error?: string; upToDate?: boolean } };

    // The failure itself is right: the batch is neither empty nor committed, so nothing is announced yet.
    expect(body.v4.upToDate).toBe(false);
    expect(typeof body.v4.error).toBe('string');

    // The defect: the scan's `error` is viem's full message, which carries the provider URL (its key) and the
    // multicall's calldata (every account address the roster rule read).
    expect(text).not.toContain(SENTINEL_KEY);
    expect(text.toLowerCase()).not.toContain(ALICE.slice(2));
    await t.close();
  }, 30_000);
});
