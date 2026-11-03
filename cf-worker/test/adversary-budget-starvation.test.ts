// Adversary on fix/resolver-no-batch 6668b66: the main loop walks markets in id order from 0 every tick and stops at
// the first market reached with less than TICK_MIN_LEFT_MS (15 s) of the 50 s budget left (src/index.ts runResolver,
// `if (outOfTime(`market ${i}`)) break;`). Nothing rotates the starting point and nothing caps what one market may
// spend. So pools that never settle and cost time every tick, placed before a pool that could settle, keep that pool
// from ever being reached.
//
// Spec (brief, rule 4): "No market may be starved for ever by the markets before it."
//
// The world: markets 0, 1 and 2 are two-sided football pools, closed, whose matches football-data.org reports as
// SUSPENDED (pending: deriveFootballOutcome returns null, and a two-sided pool is never force-refunded with
// FORCE_REFUND_TWO_SIDED off, so each stays fetch_and_resolve for ever and is fetched every tick). football-data.org is
// slow but answers: 14 s per request, inside every timeout the tick has. Market 3 is a two-sided BTC pool, closed,
// with a CoinGecko price available: it can settle the moment the loop reaches it. Two ticks run back to back; the tick
// state that decides the order (ids from 0, no carry-over) is the same each time, so the second tick shows the first
// was not a one-off.
//
// Against 2159977 (no budget) the loop reaches market 3 after about 42 s and settles it (the tick runs long instead).
// DRY_RUN=1 so no send is stubbed: the dry-run line for market 3 is the decision, reached or not. Markets are encoded
// with the repo's own ABI (src/abi.ts); the chain answers as in adversary-tick-budget-hang.test.ts. No network.
import { decodeFunctionData, encodeFunctionResult, stringToHex, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makoAbi } from '../src/abi';
import { viaMulticall } from './multicall-fake';
import { runResolver, type Env } from '../src/index';

const MAKO = '0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195';
const MAKO_RPC = 'http://public-monad-rpc.stub/';
const FINAL_BLOCK = 0x4930000n;
const ZERO_WORD = `0x${'0'.repeat(64)}`;
const FOOTBALL_LATENCY_MS = 14_000;

const key = generatePrivateKey();
const resolverAddr = privateKeyToAccount(key).address;
const NOW = Math.floor(Date.now() / 1000);

// Three suspended football pools (distinct matches, so the per-tick cache never helps), then one settleable BTC pool.
const world = ['football:900001', 'football:900002', 'football:900003', 'btc'] as const;

function market(id: number) {
  const kind = world[id];
  const close = NOW - 3 * 3600;
  const football = kind.startsWith('football:');
  return {
    creator: resolverAddr,
    mType: football ? 0 : 1,
    oracleRef: stringToHex(football ? `${kind.slice(9)}:home_win:0` : 'BTC:gt:100000', { size: 32 }),
    question: football ? `Will Home FC beat Away FC? (${id})` : 'Will BTC trade above 100000?',
    createdAt: BigInt(close - 3600),
    closeTime: BigInt(close),
    bettingCloseTime: BigInt(close - 60),
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

const footballCalls: string[] = [];

/// football-data.org answering after `ms`, or failing if the caller aborts first.
function slowFootball(url: string, signal: AbortSignal | null | undefined): Promise<Response> {
  footballCalls.push(url);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(new Response(JSON.stringify({ id: Number(url.split('/').pop()), status: 'SUSPENDED', score: { winner: null, fullTime: { home: 1, away: 1 } } }), { status: 200, headers: { 'content-type': 'application/json' } })), FOOTBALL_LATENCY_MS);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('aborted', 'AbortError'));
    });
  });
}

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith('https://api.football-data.org/v4/matches/')) return slowFootball(url, init?.signal);
  if (url.startsWith('https://api.coingecko.com/')) {
    return new Response(JSON.stringify({ bitcoin: { usd: 123_456 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url !== MAKO_RPC) throw new Error(`stub: unexpected request to ${url}`);
  const body = JSON.parse(String(init?.body));
  // Arrays are answered here (unlike the public RPC since 2026-11-03) only so the same test can run against 2159977,
  // which batches; 6668b66 never sends one (adversary-resolver-no-batch.test.ts).
  const out = Array.isArray(body) ? (body as Rpc[]).map(answer) : answer(body as Rpc);
  return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  footballCalls.length = 0;
});

describe('adversary rule 4: pools that never settle and cost time each tick starve the pool after them', () => {
  it('market 3 (BTC, price available) is never reached while markets 0-2 (suspended football) are fetched first', async () => {
    vi.stubGlobal('fetch', vi.fn(stubFetch));
    const lines: string[] = [];
    for (const k of ['log', 'warn', 'error'] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
    const env = { MAKO_ADDRESS: MAKO, MONAD_RPC_URL: MAKO_RPC, ADMIN_PRIVATE_KEY: key, FOOTBALL_DATA_API_KEY: 'adversary-sentinel-not-a-key', DRY_RUN: '1' } as Env;

    const decidedTicks: boolean[] = [];
    for (let tick = 0; tick < 2; tick++) {
      const from = lines.length;
      await runResolver(env, Date.now());
      const tickLines = lines.slice(from);
      // The football pools really were evaluated (and stayed pending), so the scenario ran.
      expect(tickLines.some((l) => /market 0: football match 900001 status SUSPENDED/.test(l)), tickLines.join('\n')).toBe(true);
      decidedTicks.push(tickLines.some((l) => /market 3: BTC gt 100000 .*DRY RUN/.test(l)));
    }
    // Rule 4: market 3 can settle on every tick (its price is there and nothing is sent before it), so it must be
    // reached on some tick. Against 6668b66 it is reached on none.
    expect(decidedTicks, `market 3 decided per tick: ${JSON.stringify(decidedTicks)}\n${lines.join('\n')}`).toContain(true);
  }, 240_000);
});
