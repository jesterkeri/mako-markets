// Chain reads. One JSON-RPC call per HTTP request: the public Monad RPC has answered array bodies with 403 since
// 2026-11-03 (DONE.md), so nothing here batches; many reads go through Multicall3 as ONE eth_call instead.
// A failure is a kind, never a guess: the caller fails closed.
import { decodeErrorResult, decodeFunctionResult, encodeFunctionData, toEventSelector, type Hex } from 'viem';
import { decodeExchangeLog, decodeMarketOf, decodeResult, encodeCall, EXCHANGE_ABI, type ExchangeLog, type MarketView, type OrderTuple } from './abi';
import { LOG_CHUNK_BLOCKS, SIG_CHECK_CALL_GAS } from './config';
import { send, type FailKind, type Net } from './net';

export const MULTICALL3: Hex = '0xcA11bde05977b3631167028862bE2a173976CA11';

const AGGREGATE3_ABI = [
  {
    type: 'function',
    name: 'aggregate3',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'allowFailure', type: 'bool' },
          { name: 'callData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      {
        name: 'returnData',
        type: 'tuple[]',
        components: [
          { name: 'success', type: 'bool' },
          { name: 'returnData', type: 'bytes' },
        ],
      },
    ],
  },
] as const;

export class ChainError extends Error {
  constructor(public kind: FailKind | 'rpc_error' | 'bad_response' | 'wrong_chain', public method: string) {
    super(`${method}: ${kind}`);
  }
}

const RATE_LIMIT_CODES = new Set([-32011, -32005, 429]);

type RpcOk = { ok: true; result: unknown };
type RpcFail = { ok: false; kind: FailKind | 'rpc_error'; code?: number; data?: unknown };

export async function rpc(net: Net, url: string, method: string, params: unknown[]): Promise<RpcOk | RpcFail> {
  const res = await send(net, url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) return { ok: false, kind: res.kind };
  let parsed: { id?: unknown; result?: unknown; error?: { code?: unknown; data?: unknown } } | null;
  try {
    parsed = JSON.parse(res.text);
  } catch {
    return { ok: false, kind: 'bad_response' };
  }
  // A JSON-RPC array answer to a single request is never valid here.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || parsed.id !== 1) return { ok: false, kind: 'bad_response' };
  if (parsed.error !== undefined && parsed.error !== null) {
    const code = typeof parsed.error.code === 'number' ? parsed.error.code : undefined;
    return { ok: false, kind: code !== undefined && RATE_LIMIT_CODES.has(code) ? 'rate_limited' : 'rpc_error', code, data: parsed.error.data };
  }
  if (!('result' in parsed)) return { ok: false, kind: 'bad_response' };
  return { ok: true, result: parsed.result };
}

const HEX = /^0x[0-9a-fA-F]*$/;

export interface ChainCtx {
  net: Net;
  rpcUrl: string;
  exchange: Hex;
  chainId: number;
}

async function must(c: ChainCtx, method: string, params: unknown[]): Promise<unknown> {
  const r = await rpc(c.net, c.rpcUrl, method, params);
  if (!r.ok) throw new ChainError(r.kind, method);
  return r.result;
}

/// Proves the endpoint is the chain the exchange runs on, before anything it says is believed.
export async function checkChainId(c: ChainCtx): Promise<void> {
  const v = await must(c, 'eth_chainId', []);
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{1,16}$/.test(v) || BigInt(v) !== BigInt(c.chainId)) throw new ChainError('wrong_chain', 'eth_chainId');
}

export async function blockNumber(c: ChainCtx): Promise<bigint> {
  const v = await must(c, 'eth_blockNumber', []);
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{1,16}$/.test(v)) throw new ChainError('bad_response', 'eth_blockNumber');
  return BigInt(v);
}

export async function getCode(c: ChainCtx, addr: Hex): Promise<string> {
  const v = await must(c, 'eth_getCode', [addr, 'latest']);
  if (typeof v !== 'string' || !HEX.test(v)) throw new ChainError('bad_response', 'eth_getCode');
  return v.toLowerCase();
}

export async function getStorageAt(c: ChainCtx, addr: Hex, slot: Hex): Promise<string> {
  const v = await must(c, 'eth_getStorageAt', [addr, slot, 'latest']);
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(v)) throw new ChainError('bad_response', 'eth_getStorageAt');
  // Nodes may strip leading zeros; compare as a full 32-byte word.
  return `0x${v.slice(2).padStart(64, '0').toLowerCase()}`;
}

export interface Read {
  target: Hex;
  data: Hex;
}

export interface ReadResult {
  success: boolean;
  returnData: Hex;
}

/// Many reads in ONE eth_call through Multicall3. Each may fail on its own and is reported, never dropped.
export async function multicall(c: ChainCtx, reads: Read[]): Promise<ReadResult[]> {
  const data = encodeFunctionData({
    abi: AGGREGATE3_ABI,
    functionName: 'aggregate3',
    // Lowercase: viem refuses a mixed-case address whose checksum is off; lowercase has none to fail.
    args: [reads.map((r) => ({ target: r.target.toLowerCase() as Hex, allowFailure: true, callData: r.data }))],
  });
  const v = await must(c, 'eth_call', [{ to: MULTICALL3, data }, 'latest']);
  if (typeof v !== 'string' || !HEX.test(v)) throw new ChainError('bad_response', 'eth_call');
  try {
    const out = decodeFunctionResult({ abi: AGGREGATE3_ABI, functionName: 'aggregate3', data: v as Hex });
    if (out.length !== reads.length) throw new Error('length');
    return out.map((o) => ({ success: o.success, returnData: o.returnData as Hex }));
  } catch {
    throw new ChainError('bad_response', 'eth_call');
  }
}

export interface IntakeReads {
  market: MarketView;
  nonce: bigint;
  filled: bigint;
  cancelled: boolean;
  /// Free cash for a buy, the maker's shares of the order's option for a sell.
  balance: bigint;
  /// feeOf(size, price) for a buy; 0 for a sell.
  fee: bigint;
}

/// Plan 6.2 step 3: the market, the nonce, the order's own state, and the maker's cash or shares, in one multicall.
export async function readIntake(c: ChainCtx, o: OrderTuple, hash: Hex): Promise<IntakeReads> {
  const reads: Read[] = [
    { target: c.exchange, data: encodeCall('marketOf', [o.marketId]) },
    { target: c.exchange, data: encodeCall('nonces', [o.maker]) },
    { target: c.exchange, data: encodeCall('orders', [hash]) },
    o.isBuy
      ? { target: c.exchange, data: encodeCall('cash', [o.maker]) }
      : { target: c.exchange, data: encodeCall('positionOf', [o.marketId, o.option, o.maker]) },
  ];
  if (o.isBuy) reads.push({ target: c.exchange, data: encodeCall('feeOf', [o.marketId, o.size, BigInt(o.price)]) });
  const res = await multicall(c, reads);
  if (res.some((r) => !r.success)) throw new ChainError('rpc_error', 'multicall');
  const market = decodeMarketOf(res[0].returnData);
  if (!market) throw new ChainError('bad_response', 'marketOf');
  try {
    const ord = decodeResult('orders', res[2].returnData) as readonly [bigint, boolean];
    return {
      market,
      nonce: BigInt(decodeResult('nonces', res[1].returnData) as bigint),
      filled: BigInt(ord[0]),
      cancelled: Boolean(ord[1]),
      balance: BigInt(decodeResult(o.isBuy ? 'cash' : 'positionOf', res[3].returnData) as bigint),
      fee: o.isBuy ? BigInt(decodeResult('feeOf', res[4].returnData) as bigint) : 0n,
    };
  } catch {
    throw new ChainError('bad_response', 'multicall');
  }
}

export type SigCheck = { kind: 'valid' } | { kind: 'invalid' } | { kind: 'revert'; name: string };

/// Plan 6.2 step 2: the exchange's own check (`isValidOrderSignature`) with a 1,000,000 gas allowance, so intake
/// and settlement run the same code under the same SIG_GAS bound.
export async function isValidOrderSignature(c: ChainCtx, o: OrderTuple, signature: Hex): Promise<SigCheck> {
  const data = encodeCall('isValidOrderSignature', [o, signature]);
  const r = await rpc(c.net, c.rpcUrl, 'eth_call', [{ to: c.exchange, data, gas: `0x${SIG_CHECK_CALL_GAS.toString(16)}` }, 'latest']);
  if (!r.ok) {
    // A revert comes back as an error carrying the revert data; a transport failure carries none.
    if (r.kind === 'rpc_error' && typeof r.data === 'string' && HEX.test(r.data) && r.data.length >= 10) {
      try {
        const err = decodeErrorResult({ abi: EXCHANGE_ABI, data: r.data as Hex });
        return { kind: 'revert', name: err.errorName };
      } catch {
        throw new ChainError('rpc_error', 'eth_call');
      }
    }
    throw new ChainError(r.kind, 'eth_call');
  }
  if (typeof r.result !== 'string' || !HEX.test(r.result)) throw new ChainError('bad_response', 'eth_call');
  try {
    return decodeResult('isValidOrderSignature', r.result as Hex) === true ? { kind: 'valid' } : { kind: 'invalid' };
  } catch {
    throw new ChainError('bad_response', 'eth_call');
  }
}

/// Plan 3.4: the roles the contract refuses as parties, read from the contract in one multicall: the admin, the
/// resolver, `TREASURY`, and whether each given address is an operator.
export async function readRefusedRoles(c: ChainCtx, addrs: Hex[]): Promise<Set<Hex>> {
  const reads: Read[] = [
    { target: c.exchange, data: encodeCall('admin') },
    { target: c.exchange, data: encodeCall('resolver') },
    { target: c.exchange, data: encodeCall('TREASURY') },
    ...addrs.map((a) => ({ target: c.exchange, data: encodeCall('isOperator', [a]) })),
  ];
  const res = await multicall(c, reads);
  if (res.some((r) => !r.success)) throw new ChainError('rpc_error', 'multicall');
  const refused = new Set<Hex>();
  try {
    for (let i = 0; i < 3; i++) refused.add((decodeResult(['admin', 'resolver', 'TREASURY'][i], res[i].returnData) as string).toLowerCase() as Hex);
    addrs.forEach((a, i) => {
      if (decodeResult('isOperator', res[3 + i].returnData) === true) refused.add(a.toLowerCase() as Hex);
    });
  } catch {
    throw new ChainError('bad_response', 'multicall');
  }
  return refused;
}

/// Reads the cancel and nonce events from `from` to `to` (inclusive) in chunks the RPC accepts. A log that does
/// not decode stops the read: the cursor must not move past an event that was not understood.
export async function readLogs(c: ChainCtx, from: bigint, to: bigint): Promise<ExchangeLog[]> {
  const out: ExchangeLog[] = [];
  for (let start = from; start <= to; start += BigInt(LOG_CHUNK_BLOCKS)) {
    const end = start + BigInt(LOG_CHUNK_BLOCKS) - 1n < to ? start + BigInt(LOG_CHUNK_BLOCKS) - 1n : to;
    out.push(...(await readLogChunk(c, start, end)));
  }
  return out;
}

export async function readLogChunk(c: ChainCtx, from: bigint, to: bigint): Promise<ExchangeLog[]> {
  const topics = EXCHANGE_ABI.filter((e) => e.type === 'event' && (e.name === 'Cancelled' || e.name === 'NonceIncremented')).map((e) => eventTopic(e));
  const v = await must(c, 'eth_getLogs', [{ address: c.exchange, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, topics: [topics] }]);
  if (!Array.isArray(v)) throw new ChainError('bad_response', 'eth_getLogs');
  const logs: ExchangeLog[] = [];
  for (const l of v as { topics?: Hex[]; data?: Hex; blockNumber?: Hex }[]) {
    if (!l || !Array.isArray(l.topics) || typeof l.data !== 'string' || typeof l.blockNumber !== 'string') throw new ChainError('bad_response', 'eth_getLogs');
    const d = decodeExchangeLog({ topics: l.topics, data: l.data, blockNumber: l.blockNumber });
    if (!d) throw new ChainError('bad_response', 'eth_getLogs');
    logs.push(d);
  }
  return logs;
}

function eventTopic(e: unknown): Hex {
  return toEventSelector(e as Parameters<typeof toEventSelector>[0]);
}

// ---- reads the settler needs (phase B). Nothing here sends a transaction. ----

const QTY = /^0x[0-9a-fA-F]{1,64}$/;

function qty(v: unknown, method: string): bigint {
  if (typeof v !== 'string' || !QTY.test(v)) throw new ChainError('bad_response', method);
  return BigInt(v);
}

export async function getBalance(c: ChainCtx, addr: Hex): Promise<bigint> {
  return qty(await must(c, 'eth_getBalance', [addr, 'latest']), 'eth_getBalance');
}

/// The account's next nonce at `pending` (what the node will accept), or at `latest` (what is mined).
export async function getNonce(c: ChainCtx, addr: Hex, tag: 'pending' | 'latest'): Promise<bigint> {
  return qty(await must(c, 'eth_getTransactionCount', [addr, tag]), 'eth_getTransactionCount');
}

export async function baseFee(c: ChainCtx): Promise<bigint> {
  const b = (await must(c, 'eth_getBlockByNumber', ['latest', false])) as { baseFeePerGas?: unknown } | null;
  if (!b) throw new ChainError('bad_response', 'eth_getBlockByNumber');
  return qty(b.baseFeePerGas, 'eth_getBlockByNumber');
}

export async function priorityFee(c: ChainCtx): Promise<bigint> {
  return qty(await must(c, 'eth_maxPriorityFeePerGas', []), 'eth_maxPriorityFeePerGas');
}

export async function estimateGas(c: ChainCtx, from: Hex, data: Hex): Promise<{ ok: true; gas: bigint } | { ok: false; kind: string }> {
  const r = await rpc(c.net, c.rpcUrl, 'eth_estimateGas', [{ from, to: c.exchange, data }, 'latest']);
  if (r.ok) return { ok: true, gas: qty(r.result, 'eth_estimateGas') };
  // A revert is an answer (the trace already told us why); anything else is the node failing.
  if (r.kind === 'rpc_error') return { ok: false, kind: 'reverted' };
  throw new ChainError(r.kind, 'eth_estimateGas');
}

/// debug_traceCall with the call tracer at `latest`. Null when the node cannot give one (the caller holds).
export async function traceCall(c: ChainCtx, from: Hex, data: Hex): Promise<unknown | null> {
  const r = await rpc(c.net, c.rpcUrl, 'debug_traceCall', [{ from, to: c.exchange, data }, 'latest', { tracer: 'callTracer' }]);
  return r.ok ? r.result : null;
}

export async function traceTransaction(c: ChainCtx, hash: Hex): Promise<unknown | null> {
  const r = await rpc(c.net, c.rpcUrl, 'debug_traceTransaction', [hash, { tracer: 'callTracer' }]);
  return r.ok ? r.result : null;
}

export interface Receipt {
  status: 0 | 1;
  effectiveGasPrice: bigint | null;
  gasUsed: bigint | null;
  blockNumber: bigint | null;
}

export async function getReceipt(c: ChainCtx, hash: Hex): Promise<Receipt | null> {
  const v = (await must(c, 'eth_getTransactionReceipt', [hash])) as { status?: unknown; effectiveGasPrice?: unknown; gasUsed?: unknown; blockNumber?: unknown } | null;
  if (v === null) return null;
  if (v.status !== '0x1' && v.status !== '0x0') throw new ChainError('bad_response', 'eth_getTransactionReceipt');
  const opt = (x: unknown) => (typeof x === 'string' && QTY.test(x) ? BigInt(x) : null);
  return { status: v.status === '0x1' ? 1 : 0, effectiveGasPrice: opt(v.effectiveGasPrice), gasUsed: opt(v.gasUsed), blockNumber: opt(v.blockNumber) };
}

export async function getTxInput(c: ChainCtx, hash: Hex): Promise<{ input: Hex; from: Hex; nonce: bigint } | null> {
  const v = (await must(c, 'eth_getTransactionByHash', [hash])) as { input?: unknown; from?: unknown; nonce?: unknown } | null;
  if (v === null) return null;
  if (typeof v.input !== 'string' || !HEX.test(v.input) || typeof v.from !== 'string') throw new ChainError('bad_response', 'eth_getTransactionByHash');
  return { input: v.input.toLowerCase() as Hex, from: v.from.toLowerCase() as Hex, nonce: qty(v.nonce, 'eth_getTransactionByHash') };
}

export async function readPaused(c: ChainCtx): Promise<boolean> {
  const r = await multicall(c, [{ target: c.exchange, data: encodeCall('paused') }]);
  if (!r[0].success) throw new ChainError('rpc_error', 'paused');
  return decodeResult('paused', r[0].returnData) === true;
}

export async function readIsOperator(c: ChainCtx, who: Hex): Promise<boolean> {
  const r = await multicall(c, [{ target: c.exchange, data: encodeCall('isOperator', [who]) }]);
  if (!r[0].success) throw new ChainError('rpc_error', 'isOperator');
  return decodeResult('isOperator', r[0].returnData) === true;
}

/// `cap()` of the funder contract (MakoFunder, slice 2a: not built yet, so this is the only function the settler
/// asks of it). Null when it cannot be read.
export async function readFunderCap(c: ChainCtx, funder: Hex): Promise<bigint | null> {
  const r = await rpc(c.net, c.rpcUrl, 'eth_call', [{ to: funder, data: '0x355274ea' }, 'latest']); // cap()
  if (!r.ok || typeof r.result !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(r.result)) return null;
  return BigInt(r.result);
}
