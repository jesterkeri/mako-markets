// Adversary on fix/resolver-no-batch b52c114: tickOrder rotates the slow pools by `minute % slow.length`, but the slow
// set itself changes every minute, because the Data Streams turn (dsTurns, DS_PER_TICK = 2 rotating through the
// eligible crypto pools by the minute) puts different pools into it. The rotation offset and the pool's position in
// the slow list then move together, and a slow pool can sit behind a pool that eats the budget on every single minute.
// The b52c114 comment only claims the bound "with an unchanged set of slow pools".
//
// Spec (brief, rule 4): "No market may be starved for ever by the markets before it, whatever their ids, types or
// upstream latency. Every due market is eventually settled."
//
// The world (ids are market ids, all two-sided and closed 3 h ago):
//   0, 1, 2, 5  CRYPTO BTC pools, CRYPTO_PRICE_SOURCE=datastreams. Data Streams answers 404 at once (cheap "wait").
//   3           FOOTBALL, match 700003: football-data.org answers SUSPENDED after 40 s (slow but inside every timeout
//               the tick has: tickFetch caps at the deadline, 50 s from the scheduled time).
//   4           FOOTBALL, match 700004: FINISHED, HOME_TEAM won, answered at once. It can settle the moment it is reached.
// Eligible DS pools [0,1,2,5]: even minutes {0,1} take the turn, slow = [0,1,3,4], offset m%4 in {0,2}: orders
// [0,1,3,4] and [3,4,0,1]. Odd minutes {2,5}: slow = [2,3,4,5], offset in {1,3}: orders [3,4,5,2] and [5,2,3,4].
// Market 3 precedes market 4 on every minute, its 40 s leaves under 15 s, and the loop breaks before market 4.
//
// Time: Date is faked (vitest, toFake ['Date']) so each tick runs at a chosen minute with its scheduled time on the
// minute; the slow upstream moves the clock forward 40 s before it answers, which is what a 40 s answer does to every
// Date.now() the tick reads afterwards. Timers stay real (the scan's 500 ms pause runs). DRY_RUN=1: the dry-run line
// for market 4 is the decision, reached or not. Markets are encoded with the repo's own ABI (src/abi.ts) through viem;
// the chain answers single calls only and refuses array bodies, as the public Monad RPC does since 2026-11-03.
// No network.
//
// Against 2159977 (no budget, ascending order): market 3 costs 40 s, then market 4 is reached and decided in the same
// tick, every tick. The control case below shows this fixture decides market 4 when market 3 answers fast.
import { decodeFunctionData, encodeFunctionResult, stringToHex, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makoAbi } from '../src/abi';
import { viaMulticall } from './multicall-fake';
import { runResolver, tickOrder, type Env } from '../src/index';

const MAKO = '0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195';
const MAKO_RPC = 'http://public-monad-rpc.stub/';
const FINAL_BLOCK = 0x4930000n;
const ZERO_WORD = `0x${'0'.repeat(64)}`;

const key = generatePrivateKey();
const resolverAddr = privateKeyToAccount(key).address;
const BASE_MINUTE = Math.floor(Date.now() / 60_000);
const CLOSE = BASE_MINUTE * 60 - 3 * 3600;

type Kind = 'ds' | `football:${string}`;
const world: Kind[] = ['ds', 'ds', 'ds', 'football:700003', 'football:700004', 'ds'];
const SLOW_MATCH = '700003';
let slowMs = 40_000;

function market(id: number) {
  const kind = world[id];
  const football = kind.startsWith('football:');
  return {
    creator: resolverAddr,
    mType: football ? 0 : 1,
    oracleRef: stringToHex(football ? `${kind.slice(9)}:home_win:0` : 'BTC:gt:100000', { size: 32 }),
    question: `pool ${id}`,
    createdAt: BigInt(CLOSE - 3600),
    closeTime: BigInt(CLOSE),
    bettingCloseTime: BigInt(CLOSE - 60),
    totalYes: 10n ** 6n,
    totalNo: 10n ** 6n,
    yesBettorCount: 1,
    noBettorCount: 1,
    outcome: 0,
    resolved: false,
    creatorFeeClaimed: false,
    protocolFeeBpsSnapshot: 0,
    creatorFeeBpsSnapshot: 0,
  };
}

function block(n: bigint) {
  return {
    number: `0x${n.toString(16)}`,
    hash: `0x${n.toString(16).padStart(64, '0')}`,
    parentHash: ZERO_WORD,
    timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`,
    baseFeePerGas: '0x174876e800',
    gasLimit: '0x1c9c380',
    gasUsed: '0x0',
    miner: '0x0000000000000000000000000000000000000000',
    extraData: '0x',
    logsBloom: `0x${'0'.repeat(512)}`,
    nonce: '0x0000000000000000',
    difficulty: '0x0',
    totalDifficulty: '0x0',
    sha3Uncles: ZERO_WORD,
    stateRoot: ZERO_WORD,
    receiptsRoot: ZERO_WORD,
    transactionsRoot: ZERO_WORD,
    mixHash: ZERO_WORD,
    size: '0x100',
    transactions: [],
    uncles: [],
  };
}

type Rpc = { id: number; jsonrpc: string; method: string; params?: unknown[] };

function answer(m: Rpc) {
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id: m.id, result });
  switch (m.method) {
    case 'eth_chainId':
      return ok('0x279f');
    case 'eth_blockNumber':
      return ok(`0x${(FINAL_BLOCK + 2n).toString(16)}`);
    case 'eth_getBlockByNumber': {
      const tag = m.params![0] as string;
      return ok(block(tag === 'finalized' ? FINAL_BLOCK : tag === 'latest' || tag === 'pending' ? FINAL_BLOCK + 2n : BigInt(tag)));
    }
    case 'eth_getTransactionCount':
      return ok('0x9');
    case 'eth_call':
      return ok(
        viaMulticall(m.params![0] as { to?: string; data: Hex }, (data) => {
          const d = decodeFunctionData({ abi: makoAbi, data });
          return d.functionName === 'owner' || d.functionName === 'resolver'
            ? encodeFunctionResult({ abi: makoAbi, functionName: d.functionName, result: resolverAddr })
            : d.functionName === 'nextMarketId'
              ? encodeFunctionResult({ abi: makoAbi, functionName: 'nextMarketId', result: BigInt(world.length) })
              : encodeFunctionResult({ abi: makoAbi, functionName: 'getMarket', result: market(Number((d.args as [bigint])[0])) as never });
        }),
      );
    default:
      return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `stub: ${m.method}` } };
  }
}

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const footballCalls: string[] = [];

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith('https://api.football-data.org/v4/matches/')) {
    const id = url.split('/').pop()!;
    footballCalls.push(id);
    if (id === SLOW_MATCH) {
      // A 40 s answer: every later Date.now() in the tick is 40 s on.
      vi.setSystemTime(Date.now() + slowMs);
      return json({ id: Number(id), status: 'SUSPENDED', score: { winner: null, fullTime: { home: 1, away: 1 } } });
    }
    return json({ id: Number(id), status: 'FINISHED', score: { winner: 'HOME_TEAM', fullTime: { home: 2, away: 0 } } });
  }
  if (url.startsWith('https://api.testnet-dataengine.chain.link/')) return json({ error: 'not found' }, 404);
  if (url !== MAKO_RPC) throw new Error(`stub: unexpected request to ${url}`);
  const body = JSON.parse(String(init?.body));
  if (Array.isArray(body)) return new Response('Restricted JSON RPC method', { status: 403 });
  return json(answer(body as Rpc));
}

const env = {
  MAKO_ADDRESS: MAKO,
  MONAD_RPC_URL: MAKO_RPC,
  ADMIN_PRIVATE_KEY: key,
  FOOTBALL_DATA_API_KEY: 'adversary-sentinel-not-a-key',
  CRYPTO_PRICE_SOURCE: 'datastreams',
  DATASTREAMS_API_KEY: 'adversary-sentinel-ds-key',
  DATASTREAMS_API_SECRET: 'adversary-sentinel-ds-secret',
  ALCHEMY_RPC_URL: 'https://monad-testnet.g.alchemy.com/v2/adversary-sentinel',
  DRY_RUN: '1',
} as Env;

/// Runs one tick per minute for `minutes` minutes, each scheduled on its minute; returns per tick whether market 4 was
/// decided and whether market 3's slow match was fetched.
async function runMinutes(minutes: number): Promise<{ decided: boolean[]; slowFetched: boolean[]; log: string; ticks: string[][] }> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.stubGlobal('fetch', vi.fn(stubFetch));
  const lines: string[] = [];
  for (const k of ['log', 'warn', 'error'] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
  const decided: boolean[] = [];
  const slowFetched: boolean[] = [];
  const ticks: string[][] = [];
  for (let k = 0; k < minutes; k++) {
    const scheduled = (BASE_MINUTE + 1 + k) * 60_000;
    vi.setSystemTime(scheduled + 200);
    const from = lines.length;
    footballCalls.length = 0;
    await runResolver(env, scheduled);
    const tickLines = lines.slice(from);
    ticks.push(tickLines);
    decided.push(tickLines.some((l) => /market 4: 700004 home_win .*DRY RUN/.test(l)));
    slowFetched.push(footballCalls.includes(SLOW_MATCH));
  }
  return { decided, slowFetched, log: lines.join('\n'), ticks };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  slowMs = 40_000;
});

describe('adversary rule 4: the slow-pool rotation is defeated by a slow set that changes each minute', () => {
  it('control: with market 3 answering at once, market 4 (finished match) is decided on every tick', async () => {
    slowMs = 0;
    const r = await runMinutes(4);
    expect(r.decided, r.log).toEqual([true, true, true, true]);
  }, 60_000);

  it('market 4 is reached on some minute while market 3 (football, 40 s answers) and the Data Streams turn rotate', async () => {
    // Twelve minutes: three full periods of the order (Data Streams turn period 2, slow-list length 4).
    const r = await runMinutes(12);
    // The scenario ran: market 3 was evaluated on every tick.
    expect(r.slowFetched, r.log).toEqual(Array(12).fill(true));
    // Rule 4: market 4 can settle whenever it is reached. Against b52c114 it is reached on no minute, for ever.
    expect(r.decided, `market 4 decided per minute: ${JSON.stringify(r.decided)}\n${r.log}`).toContain(true);
  }, 120_000);

  // Builder's case (fix after this adversary pass): the first slow pool of each minute always gets a Data Streams turn,
  // so a Data Streams pool is never left behind a budget-eating pool by turns that never line up with its rotation slot.
  it('the first slow pool of each minute, when it settles on Data Streams, is evaluated rather than told to wait its turn', async () => {
    const r = await runMinutes(6);
    const leads = r.ticks.map((_, k) => tickOrder(world.length, [0, 1, 2, 3, 4, 5], (BASE_MINUTE + 1 + k) * 60_000)[0]);
    for (const [k, lead] of leads.entries()) {
      if (world[lead] !== 'ds') continue;
      const mine = r.ticks[k].filter((l) => l.includes(`market ${lead}: datastreams`));
      expect({ k, lead, mine }, r.log).toEqual({ k, lead, mine: [expect.not.stringContaining("not this tick's turn")] });
    }
    expect(leads.filter((l) => world[l] === 'ds').length).toBeGreaterThan(0);
  }, 120_000);
});
