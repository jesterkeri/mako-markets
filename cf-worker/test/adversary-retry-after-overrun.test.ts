// Adversary on fix/resolver-no-batch 6668b66: tickFetch makes every request fail at once past the tick's deadline,
// "so viem's retries cost only their backoff" (src/index.ts runResolver). viem's backoff is not always its own
// exponential 150/300/600 ms: when an HTTP error carries a Retry-After header, viem 2.50 waits that many seconds before
// the retry (node_modules/viem/utils/buildRequest.ts, the `delay` option: "If we find a Retry-After header, let's retry
// after the given time"), with no signal and no cap. tickFetch only bounds the requests, not that wait.
//
// Spec (brief, rule 2): "A tick must finish inside the minute so ticks do not overlap. The budget is 50 s measured from
// the cron's scheduled time, and every request the tick makes must end by then. This covers provider APIs, viem RPC
// calls and their retries."
//
// The world: market 0 settled, market 1 one-sided and closed (resolve_one_sided). The tick reaches the no-data send
// with 20 s left, which outOfTime allows (>= TICK_MIN_LEFT_MS). The finalized re-read answers; the nonce read gets
// HTTP 429 "Too Many Requests" with `Retry-After: 30`, the standard HTTP rate-limit answer (RFC 9110 10.2.3, also sent
// with 503). viem retries a 429 (shouldRetry) after 30 s. Markets are encoded with the repo's own ABI (src/abi.ts); the
// chain answers as the stub in adversary-tick-budget-hang.test.ts (single objects only, Multicall3 unpacked by
// multicall-fake.ts). No network is touched.
import { decodeFunctionData, encodeFunctionResult, stringToHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makoAbi } from '../src/abi';
import { viaMulticall } from './multicall-fake';
import { runResolver, type Env } from '../src/index';

const MAKO = '0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195';
const MAKO_RPC = 'http://public-monad-rpc.stub/';
const FINAL_BLOCK = 0x4930000n;
const ZERO_WORD = `0x${'0'.repeat(64)}`;
const BUDGET_MS = 50_000;
const CRON_PERIOD_MS = 60_000;

const key = generatePrivateKey();
const resolverAddr = privateKeyToAccount(key).address;
const NOW = Math.floor(Date.now() / 1000);

const world: ('resolved' | 'one_sided')[] = ['resolved', 'one_sided'];

function market(id: number) {
  const kind = world[id];
  const close = NOW - 120;
  const twoSided = kind !== 'one_sided';
  return {
    creator: resolverAddr,
    mType: 1,
    oracleRef: stringToHex('BTC:gt:100000', { size: 32 }),
    question: `pool ${id}`,
    createdAt: BigInt(close - 3600),
    closeTime: BigInt(close),
    bettingCloseTime: BigInt(close - 60),
    totalYes: 10n ** 6n,
    totalNo: twoSided ? 10n ** 6n : 0n,
    yesBettorCount: 1,
    noBettorCount: twoSided ? 1 : 0,
    outcome: kind === 'resolved' ? 1 : 0,
    resolved: kind === 'resolved',
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
const rateLimited: number[] = [];

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
    case 'eth_call':
      return ok(
        viaMulticall(m.params![0] as { to?: string; data: `0x${string}` }, (data) => {
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

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  if (url !== MAKO_RPC) throw new Error(`stub: unexpected request to ${url}`);
  const body = JSON.parse(String(init?.body));
  if (Array.isArray(body)) return new Response('Restricted JSON RPC method', { status: 403 });
  if ((body as Rpc).method === 'eth_getTransactionCount') {
    rateLimited.push(Date.now());
    return new Response('Too Many Requests', { status: 429, headers: { 'Retry-After': '30', 'content-type': 'text/plain' } });
  }
  return new Response(JSON.stringify(answer(body as Rpc)), { status: 200, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rateLimited.length = 0;
});

describe('adversary tick budget: a Retry-After on an RPC error holds the tick past its deadline', () => {
  it('a nonce read answered 429 Retry-After: 30 with 20 s left keeps the tick running into the next cron tick', async () => {
    vi.stubGlobal('fetch', vi.fn(stubFetch));
    const lines: string[] = [];
    for (const k of ['log', 'warn', 'error'] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
    const startedAt = Date.now() - (BUDGET_MS - 20_000);
    const deadline = startedAt + BUDGET_MS;
    await runResolver({ MAKO_ADDRESS: MAKO, MONAD_RPC_URL: MAKO_RPC, ADMIN_PRIVATE_KEY: key } as Env, startedAt);
    const endedAt = Date.now();
    // The scenario ran: the send path reached the nonce read and it was rate-limited before the deadline.
    expect(rateLimited.length, lines.join('\n')).toBeGreaterThan(0);
    expect(rateLimited[0]).toBeLessThan(deadline);
    // Spec rule 2: the tick ends by startedAt + 50 s, and certainly before the next cron tick at startedAt + 60 s.
    expect(endedAt - deadline, `tick ended ${endedAt - startedAt} ms after its scheduled time (next tick fires at ${CRON_PERIOD_MS} ms)\n${lines.join('\n')}`).toBeLessThan(1_000);
  }, 120_000);
});
