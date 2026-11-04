// Adversary on fix/resolver-no-batch 04f52bc: the 50 s tick budget (TICK_BUDGET_MS) is only checked BEFORE a market's
// work starts (outOfTime, needs TICK_MIN_LEFT_MS = 15 s left). What runs after the check is not bounded by it:
//
//   (a) a football / NBA / CoinGecko / Pyth fetch carries no timeout at all (src/index.ts fetchFootballResult etc.),
//       so one slow upstream holds the tick open for as long as the upstream takes;
//   (b) every viem call in sendOnce (re-read, nonce reads, send) uses viem's http defaults: a 10 s timeout and 3
//       retries (a timeout is retried, viem utils/buildRequest.ts shouldRetry), so one call that does not answer costs
//       about 42 s, far more than the 15 s TICK_MIN_LEFT_MS reserves for "the finalized re-read, both nonce reads and
//       the send".
//
// Spec (brief, rule 2): "A tick must finish inside the minute so ticks do not overlap: a 50 s budget measured from the
// scheduled time." Each case below measures when runResolver returns against startedAt + 50 s. The chain answers as
// the stub in adversary-resolver-no-batch.test.ts does (single objects only, Multicall3 unpacked by multicall-fake.ts);
// markets are encoded with the repo's own ABI (src/abi.ts). No network is touched.
import { decodeFunctionData, encodeFunctionResult, keccak256, stringToHex, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makoAbi } from '../src/abi';
import { viaMulticall } from './multicall-fake';
import { runResolver, TICK_OVERRUN_MS, type Env } from '../src/index';

const MAKO = '0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195';
const MAKO_RPC = 'http://public-monad-rpc.stub/';
const FINAL_BLOCK = 0x4930000n;
const ZERO_WORD = `0x${'0'.repeat(64)}`;
const BUDGET_MS = 50_000;
const NONCE = 9;

const key = generatePrivateKey();
const resolverAddr = privateKeyToAccount(key).address;
const NOW = Math.floor(Date.now() / 1000);

type Kind = 'resolved' | 'football_two_sided' | 'one_sided';
let world: Kind[] = [];

function market(id: number) {
  const kind = world[id];
  const close = NOW - 120;
  const twoSided = kind !== 'one_sided';
  return {
    creator: resolverAddr,
    mType: kind === 'football_two_sided' ? 0 : 1,
    oracleRef: kind === 'football_two_sided' ? stringToHex('537799:home_win:0', { size: 32 }) : stringToHex('BTC:gt:100000', { size: 32 }),
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
const raws: Hex[] = [];

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
      return ok(`0x${NONCE.toString(16)}`);
    case 'eth_sendRawTransaction': {
      const raw = m.params![0] as Hex;
      raws.push(raw);
      return ok(keccak256(raw));
    }
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

/// A request that does not answer until the test ends (or until the caller aborts it, as viem does at its timeout).
const releases: (() => void)[] = [];
function hang(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((resolve, reject) => {
    const release = () => resolve(new Response('{}', { status: 504 }));
    releases.push(release);
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
}

let hangMethod: string | null = null;
/// Hang every eth_call to Multicall3, the market scan's getMarket chunks (builder, Codex R2 F1).
let hangScan = false;
let hangFootball = false;
const hung: string[] = [];

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith('https://api.football-data.org/')) {
    if (hangFootball) {
      hung.push(url);
      return hang(init?.signal);
    }
    return new Response('{}', { status: 503 });
  }
  if (url !== MAKO_RPC) throw new Error(`stub: unexpected request to ${url}`);
  const body = JSON.parse(String(init?.body));
  if (Array.isArray(body)) return new Response('Restricted JSON RPC method', { status: 403 });
  const to = ((body as Rpc).params?.[0] as { to?: string } | undefined)?.to?.toLowerCase();
  if (hangScan && (body as Rpc).method === 'eth_call' && to === '0xca11bde05977b3631167028862be2a173976ca11') {
    hung.push('aggregate3');
    return hang(init?.signal);
  }
  if ((body as Rpc).method === hangMethod) {
    hung.push((body as Rpc).method);
    return hang(init?.signal);
  }
  return new Response(JSON.stringify(answer(body as Rpc)), { status: 200, headers: { 'content-type': 'application/json' } });
}

/// Runs one tick that started at `startedAt` and reports how late (ms past startedAt + 50 s) it returned, or null if
/// it was still running `graceMs` after its deadline.
async function tickLateness(startedAt: number, graceMs: number, extra: Partial<Env> = {}): Promise<{ late: number | null; lines: string[] }> {
  vi.stubGlobal('fetch', vi.fn(stubFetch));
  const lines: string[] = [];
  for (const k of ['log', 'warn', 'error'] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
  const deadline = startedAt + BUDGET_MS;
  const run = runResolver({ MAKO_ADDRESS: MAKO, MONAD_RPC_URL: MAKO_RPC, ADMIN_PRIVATE_KEY: key, ...extra } as Env, startedAt).then(() => Date.now() - deadline);
  const limit = new Promise<null>((r) => setTimeout(() => r(null), Math.max(0, deadline + graceMs - Date.now())));
  const late = await Promise.race([run, limit]);
  // Let any hung request answer so the abandoned tick can unwind before the next test.
  for (const r of releases.splice(0)) r();
  await run.catch(() => undefined);
  return { late, lines };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const r of releases.splice(0)) r();
  raws.length = 0;
  hung.length = 0;
  hangMethod = null;
  hangFootball = false;
  hangScan = false;
  world = [];
});

describe('adversary tick budget: work started inside the budget is not bounded by it', () => {
  it('(a) a football result fetch with no timeout holds a tick that started on time past its 50 s deadline', async () => {
    // Market 0 settled, market 1 a closed two-sided football pool (fetch_and_resolve): the tick reaches it within a
    // second of starting, with the whole budget left, and football-data.org does not answer.
    world = ['resolved', 'football_two_sided'];
    hangFootball = true;
    const { late, lines } = await tickLateness(Date.now(), 2_000, { FOOTBALL_DATA_API_KEY: 'adversary-sentinel-not-a-key' } as Partial<Env>);
    expect(hung.length, lines.join('\n')).toBeGreaterThan(0);
    // The spec: the tick ends inside its 50 s budget. null = still running 2 s after the deadline.
    expect(late, `tick still running 2 s after its deadline; hung on ${hung.join(', ')}`).not.toBeNull();
    expect(late!, lines.join('\n')).toBeLessThan(1_000);
  }, 120_000);

  it('(b) a nonce read that never answers costs viem 4 x 10 s, so a send started with 20 s left ends ~20 s late', async () => {
    // Market 1 is one-sided and closed (resolve_one_sided): the no-data pass reaches sendOnce with 20 s left, which
    // outOfTime allows (>= TICK_MIN_LEFT_MS). The finalized re-read answers; eth_getTransactionCount does not.
    world = ['resolved', 'one_sided'];
    hangMethod = 'eth_getTransactionCount';
    const startedAt = Date.now() - (BUDGET_MS - 20_000);
    const { late, lines } = await tickLateness(startedAt, 30_000);
    expect(hung.length, lines.join('\n')).toBeGreaterThan(0);
    expect(raws.length).toBe(0);
    expect(late, `tick still running 30 s after its deadline; hung on ${hung.join(', ')}`).not.toBeNull();
    expect(late!, `${hung.length} hung requests (viem retries)\n${lines.join('\n')}`).toBeLessThan(1_000);
  }, 120_000);

  // Builder's case for Codex RESOLVER_NO_BATCH R2 F1: a scan chunk that starts with just over TICK_MIN_LEFT_MS left and
  // never answers is cut off at the deadline, and the tick ends at once: measured 3 ms late, against 502 ms with the
  // old fixed 500 ms scan pause. TICK_OVERRUN_MS is the general bound, for a viem retry scheduled across the deadline.
  it('(c) a scan chunk that never answers, started at the 15 s threshold, ends the tick within the stated overrun', async () => {
    world = Array(100).fill('resolved');
    hangScan = true;
    const startedAt = Date.now() - (BUDGET_MS - 15_400);
    const { late, lines } = await tickLateness(startedAt, 5_000);
    expect(hung, lines.join('\n')).toContain('aggregate3');
    expect(raws.length).toBe(0);
    expect(late, 'tick still running 5 s after its deadline').not.toBeNull();
    expect(late!, lines.join('\n')).toBeLessThan(300);
    expect(late!).toBeLessThan(TICK_OVERRUN_MS);
  }, 120_000);
});
