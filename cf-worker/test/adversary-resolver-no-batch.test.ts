// Adversary on fix/resolver-no-batch 4a9d301: runResolver end to end against a stub that answers as the public Monad
// testnet RPC did on 2026-11-03 (read-only probes from this worktree, adv-bench/resolver-no-batch/probe.mjs, fill.mjs):
//
//   * any JSON-RPC ARRAY body (a batch, even of one) -> HTTP 403, body "Restricted JSON RPC method";
//   * single objects answered normally; eth_fillTransaction IS supported and answers {raw, tx} (shape copied from the
//     real answer, values recomputed from the request), so viem 2.50 takes its gas and fees from it;
//   * about 15 items per second: here a sliding 1000 ms window, item 16 in a window gets JSON-RPC error -32011 (HTTP
//     200), the form the public RPC used in production on 2026-09-17 (DONE.md). viem does not retry -32011.
//
// Each request is delayed by `latency` before it reaches the "node". The scan's last chunk (5 eth_calls when the
// market count is a multiple of 5) is followed at once by the keeper's six sequential send-path items; below about
// 80 ms per request the window holding the last two chunks also holds eth_sendRawTransaction, item 16.
//
// The world: 200 markets (production's count today). 198 are resolved (skip). Market 150 is one-sided and past
// close + 24 h (force_refund); market 180 is one-sided, closed, before the deadline (resolve_one_sided, must be
// deferred: one broadcast a tick). Every market is encoded with the repo's own ABI (src/abi.ts).
import { decodeFunctionData, encodeFunctionResult, keccak256, parseTransaction, stringToHex, type Hex, type TransactionSerialized } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makoAbi } from '../src/abi';
import { runResolver, type Env } from '../src/index';

const MAKO = '0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195';
const MAKO_RPC = 'http://public-monad-rpc.stub/';
const FINAL_BLOCK = 0x4930000n;
const ZERO_WORD = `0x${'0'.repeat(64)}`;
const N_MARKETS = 200;
const RATE_PER_S = 15;

const key = generatePrivateKey();
const resolverAddr = privateKeyToAccount(key).address;
const NOW = Math.floor(Date.now() / 1000);

function market(id: number) {
  const refundable = id === 150; // closed 2 days ago, one-sided: force_refund
  const oneSidedFresh = id === 180; // closed 2 minutes ago, one-sided: resolve_one_sided
  const open = refundable || oneSidedFresh;
  const close = refundable ? NOW - 2 * 86_400 : NOW - 120;
  return {
    creator: resolverAddr,
    mType: 0,
    oracleRef: stringToHex('BTC>100000', { size: 32 }),
    question: `pool ${id}`,
    createdAt: BigInt(close - 3600),
    closeTime: BigInt(close),
    bettingCloseTime: BigInt(close - 60),
    totalYes: 10n ** 6n,
    totalNo: open ? 0n : 10n ** 6n,
    yesBettorCount: 1,
    noBettorCount: open ? 0 : 1,
    outcome: open ? 0 : 1,
    resolved: !open,
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
const NONCE = 9;
const raws: Hex[] = [];
const sentHashes = new Set<string>();

function answer(m: Rpc) {
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id: m.id, result });
  const err = (error: unknown) => ({ jsonrpc: '2.0', id: m.id, error });
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
    case 'eth_fillTransaction': {
      // As the public RPC answered 2026-11-03 (fill.mjs): {raw, tx} with gas, 1559 fees, nonce, chainId, null lists.
      const t = m.params![0] as { from: string; to: string; data?: string; input?: string; nonce?: string };
      return ok({
        raw: '0x02',
        tx: {
          from: t.from,
          to: t.to,
          gas: '0x76b1',
          maxFeePerGas: '0x2363e7f000',
          maxPriorityFeePerGas: '0x77359400',
          value: '0x0',
          input: t.data ?? t.input,
          data: null,
          nonce: t.nonce ?? `0x${NONCE.toString(16)}`,
          chainId: '0x279f',
          accessList: null,
          authorizationList: null,
        },
      });
    }
    case 'eth_maxPriorityFeePerGas':
      return ok('0x77359400');
    case 'eth_gasPrice':
      return ok('0x174876e800');
    case 'eth_estimateGas':
      return ok('0x30000');
    case 'eth_sendRawTransaction': {
      const raw = m.params![0] as Hex;
      raws.push(raw);
      const h = keccak256(raw);
      sentHashes.add(h);
      return ok(h);
    }
    case 'eth_getTransactionReceipt': {
      const h = m.params![0] as string;
      if (!sentHashes.has(h)) return ok(null);
      return ok({
        transactionHash: h,
        transactionIndex: '0x0',
        blockHash: `0x${(FINAL_BLOCK + 1n).toString(16).padStart(64, '0')}`,
        blockNumber: `0x${(FINAL_BLOCK + 1n).toString(16)}`,
        from: resolverAddr.toLowerCase(),
        to: MAKO.toLowerCase(),
        cumulativeGasUsed: '0x20000',
        gasUsed: '0x20000',
        effectiveGasPrice: '0x174876e800',
        contractAddress: null,
        logs: [],
        logsBloom: `0x${'0'.repeat(512)}`,
        status: '0x1',
        type: '0x2',
      });
    }
    case 'eth_call': {
      const d = decodeFunctionData({ abi: makoAbi, data: (m.params![0] as { data: Hex }).data });
      const result =
        d.functionName === 'owner' || d.functionName === 'resolver'
          ? encodeFunctionResult({ abi: makoAbi, functionName: d.functionName, result: resolverAddr })
          : d.functionName === 'nextMarketId'
            ? encodeFunctionResult({ abi: makoAbi, functionName: 'nextMarketId', result: BigInt(N_MARKETS) })
            : encodeFunctionResult({ abi: makoAbi, functionName: 'getMarket', result: market(Number((d.args as [bigint])[0])) as never });
      return ok(result);
    }
    default:
      return err({ code: -32601, message: `stub: ${m.method}` });
  }
}

// ---- the public RPC's behaviour ----------------------------------------------------------------------------------

let latencyMs = 0;
let arrays = 0;
let limited = 0;
const limitedMethods: string[] = [];
const itemTimes: number[] = [];
const methods: string[] = [];

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  if (url !== MAKO_RPC) throw new Error(`stub: unexpected request to ${url}`);
  if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
  const body = JSON.parse(String(init?.body));
  if (Array.isArray(body)) {
    arrays++;
    return new Response('Restricted JSON RPC method', { status: 403 });
  }
  const t = performance.now();
  const inWindow = itemTimes.filter((x) => t - x < 1000).length;
  itemTimes.push(t);
  methods.push((body as Rpc).method);
  if (inWindow >= RATE_PER_S) {
    limited++;
    limitedMethods.push((body as Rpc).method);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: (body as Rpc).id, error: { code: -32011, message: 'requests limited to 15/sec' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(JSON.stringify(answer(body as Rpc)), { status: 200, headers: { 'content-type': 'application/json' } });
}

function maxPerSecond(): number {
  let best = 0;
  for (let i = 0; i < itemTimes.length; i++) {
    let n = 0;
    for (let j = i; j < itemTimes.length && itemTimes[j] - itemTimes[i] < 1000; j++) n++;
    best = Math.max(best, n);
  }
  return best;
}

async function tick(extra: Partial<Env> = {}): Promise<string[]> {
  vi.stubGlobal('fetch', vi.fn(stubFetch));
  const lines: string[] = [];
  for (const k of ['log', 'warn', 'error'] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
  await runResolver({ MAKO_ADDRESS: MAKO, MONAD_RPC_URL: MAKO_RPC, ADMIN_PRIVATE_KEY: key, ...extra } as Env);
  return lines;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  raws.length = 0;
  sentHashes.clear();
  itemTimes.length = 0;
  methods.length = 0;
  arrays = 0;
  limited = 0;
  limitedMethods.length = 0;
  latencyMs = 0;
});

describe('adversary resolver-no-batch: a 200-market tick against the public RPC as it answers since 2026-11-03', () => {
  for (const lat of [0, 40, 120]) {
    it(`latency ${lat} ms: single objects only, never rate-limited, exactly one forceRefund(150) broadcast`, async () => {
      latencyMs = lat;
      const lines = await tick();
      const report = `arrays=${arrays} limited=${limited} (${limitedMethods.join(',')}) tail=${methods.slice(-14).join(',')} maxItemsIn1s=${maxPerSecond()} total=${itemTimes.length}`;
      console.info(report);
      expect(arrays, report).toBe(0);
      expect(limited, `${report}\n${lines.filter((l) => /limit|fail|deferred|forceRefund/i.test(l)).join('\n')}`).toBe(0);
      expect(raws.length, lines.join('\n')).toBe(1);
      const tx = parseTransaction(raws[0] as TransactionSerialized);
      expect(tx.chainId).toBe(10143);
      expect(tx.nonce).toBe(NONCE);
      const d = decodeFunctionData({ abi: makoAbi, data: tx.data! });
      expect(d.functionName).toBe('forceRefund');
      expect(d.args).toEqual([150n]);
      expect(lines.some((l) => /market 180/.test(l) && /defer/i.test(l)), lines.join('\n')).toBe(true);
    }, 120_000);
  }

  it('DRY_RUN=1 sends nothing and still uses single objects only', async () => {
    const lines = await tick({ DRY_RUN: '1' } as Partial<Env>);
    expect(arrays).toBe(0);
    expect(raws.length, lines.join('\n')).toBe(0);
    expect(methods).not.toContain('eth_sendRawTransaction');
  }, 120_000);
});
