// A fake chain node, built from the REAL exchange ABI (data/MakoOutcomeExchangeV1.abi.json): return data and
// revert data are encoded with viem against that ABI, never typed as hex. It answers the way the real node does:
// single JSON-RPC calls only (an array body is refused with 403, as the public Monad RPC has done since
// 2026-11-03), eth_getLogs limited to 100 blocks per call (the public RPC's cap), Multicall3 aggregate3 with
// per-call success flags, and a revert as JSON-RPC error code 3 carrying the revert data.
//
// `isValidOrderSignature` is answered by a model of the contract's own checker (plan 4.2): length rule, strict
// ECDSA (OpenZeppelin tryRecover), then, for a maker with the real Safe proxy code, the Safe's eth_sign branch
// (v above 30, owner of a one-owner Safe). The shared vectors, which the real contract's tests produced, check
// the model (test/vectors.test.ts).
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionResult,
  hashMessage,
  hashTypedData,
  recoverAddress,
  type Hex,
} from 'viem';
import { EXCHANGE_ABI } from '../src/abi';
import { MULTICALL3 } from '../src/chain';
import { orderHash } from '../src/order';
import { FALLBACK_HANDLER_SLOT, SAFE_4337_MODULE, SAFE_SINGLETON } from '../src/wallets';
import proxyRuntime from '../data/safe-v1.4.1/SafeProxy.runtime.hex?raw';
import { AGGREGATE3 } from './aggregate';

export const EXCHANGE: Hex = '0xe8c0000000000000000000000000000000000001';
export const CHAIN_ID = 10143;
/// Vectors expire at 2,000,000,000 s; intake allows at most 7 days ahead, so the test clock sits about a day before.
export const NOW_MS = 1_999_900_000_000;
export const HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
export const SAFE_PROXY_CODE: Hex = proxyRuntime.trim() as Hex;

export interface MarketState {
  nOptions: number;
  status: number;
  tradingClose: bigint;
  positionCap: bigint;
  feeRate: bigint;
}

export interface RecordedCall {
  method: string;
  /// For eth_call: 'aggregate3', or the exchange function name.
  name?: string;
  gas?: string;
  batch?: boolean;
}

class Revert extends Error {
  constructor(public data: Hex) {
    super('execution reverted');
  }
}

export class World {
  chainId = CHAIN_ID;
  block = 5_000n;
  nowMs = NOW_MS;
  markets = new Map<string, MarketState>([['1', { nOptions: 3, status: 1, tradingClose: 4_000_000_000n, positionCap: 10n ** 12n, feeRate: 0n }]]);
  nonces = new Map<Hex, bigint>();
  orders = new Map<Hex, { filled: bigint; cancelled: boolean }>();
  cash = new Map<Hex, bigint>();
  positions = new Map<string, bigint>();
  admin: Hex = '0xad00000000000000000000000000000000000001';
  resolver: Hex = '0xad00000000000000000000000000000000000002';
  treasury: Hex = '0xad00000000000000000000000000000000000003';
  operators = new Set<Hex>();
  code = new Map<Hex, string>();
  storage = new Map<string, Hex>();
  safeOwner = new Map<Hex, Hex>();
  logs: { block: bigint; topics: Hex[]; data: Hex }[] = [];
  calls: RecordedCall[] = [];
  /// The exchange functions Multicall3 ran inside an aggregate3 call.
  inner: string[] = [];
  /// Make one method fail like a node that is down or limiting requests.
  fail: ((method: string, name: string | undefined) => 'down' | 'rate' | 'garbage' | null) | null = null;
  /// Overrides for what eth_call answers for a given exchange function (to model another answer).
  override: ((name: string) => Hex | null) | null = null;

  setCash(a: Hex, v: bigint) {
    this.cash.set(a.toLowerCase() as Hex, v);
  }
  setPosition(m: bigint, option: number, a: Hex, v: bigint) {
    this.positions.set(`${m}:${option}:${a.toLowerCase()}`, v);
  }
  /// A Mako email Safe: the real proxy code, the real singleton and handler slots, and one owner.
  addSafe(address: Hex, owner: Hex) {
    const a = address.toLowerCase() as Hex;
    this.code.set(a, SAFE_PROXY_CODE);
    this.storage.set(`${a}:0x${'0'.repeat(64)}`, `0x${'0'.repeat(24)}${SAFE_SINGLETON.slice(2)}`);
    this.storage.set(`${a}:${FALLBACK_HANDLER_SLOT}`, `0x${'0'.repeat(24)}${SAFE_4337_MODULE.slice(2)}`);
    this.safeOwner.set(a, owner.toLowerCase() as Hex);
  }
  logCancelled(orderHash: Hex, maker: Hex, block: bigint) {
    const topics = encodeEventTopics({ abi: EXCHANGE_ABI, eventName: 'Cancelled', args: { orderHash, maker } }) as Hex[];
    this.logs.push({ block, topics, data: '0x' });
  }
  logNonce(account: Hex, nonce: bigint, block: bigint) {
    const topics = encodeEventTopics({ abi: EXCHANGE_ABI, eventName: 'NonceIncremented', args: { account } }) as Hex[];
    this.logs.push({ block, topics, data: encodeAbiParameters([{ type: 'uint256' }], [nonce]) });
  }
  ethCallCount() {
    return this.calls.filter((c) => c.method === 'eth_call').length;
  }
  exchangeCalls(name: string) {
    return this.calls.filter((c) => c.name === name).length;
  }
}

const lower = (a: string) => a.toLowerCase() as Hex;

function errData(name: string, args: unknown[] = []): Hex {
  return encodeErrorResult({ abi: EXCHANGE_ABI, errorName: name, args });
}

function strictRecover(hash: Hex, sig: Hex): Promise<Hex | null> {
  // Written separately from src/order.ts on purpose: this is the model of the contract's tryRecover.
  const bytes = (sig.length - 2) / 2;
  if (bytes !== 65) return Promise.resolve(null);
  const v = parseInt(sig.slice(130, 132), 16);
  const s = BigInt(`0x${sig.slice(66, 130)}`);
  if ((v !== 27 && v !== 28) || s > HALF_N || s === 0n) return Promise.resolve(null);
  return recoverAddress({ hash, signature: { r: `0x${sig.slice(2, 66)}`, s: `0x${sig.slice(66, 130)}`, v: BigInt(v) } })
    .then((a) => lower(a))
    .catch(() => null);
}

async function modelIsValid(w: World, args: readonly unknown[]): Promise<boolean> {
  const o = args[0] as { salt: bigint; maker: Hex; marketId: bigint; option: number; isBuy: boolean; price: number; size: bigint; expiration: bigint; nonce: bigint };
  const sig = args[1] as Hex;
  const hash = orderHash(o, { chainId: w.chainId, exchange: EXCHANGE });
  const bytes = (sig.length - 2) / 2;
  if (bytes === 0 || bytes > 195) throw new Revert(errData('BadSignatureLength', [hash]));
  const maker = lower(o.maker);
  if ((await strictRecover(hash, sig)) === maker) return true;
  const code = w.code.get(maker);
  if (!code || code === '0x') return false;
  // The Safe branch: only the real proxy with its owner, signing the eth_sign form (v 31 or 32).
  if (code !== SAFE_PROXY_CODE) return false;
  const owner = w.safeOwner.get(maker);
  if (!owner || bytes !== 65) return false;
  const v = parseInt(sig.slice(130, 132), 16);
  if (v <= 30) return false;
  const safeMsgHash = hashTypedData({
    domain: { chainId: w.chainId, verifyingContract: maker },
    types: { SafeMessage: [{ name: 'message', type: 'bytes' }] },
    primaryType: 'SafeMessage',
    message: { message: hash },
  });
  try {
    const rec = await recoverAddress({
      hash: hashMessage({ raw: safeMsgHash }),
      signature: { r: `0x${sig.slice(2, 66)}`, s: `0x${sig.slice(66, 130)}`, v: BigInt(v - 4) },
    });
    return lower(rec) === owner;
  } catch {
    return false;
  }
}

async function exchangeCall(w: World, data: Hex): Promise<{ name: string; result: Hex }> {
  const { functionName, args } = decodeFunctionData({ abi: EXCHANGE_ABI, data });
  const name = functionName as string;
  const a = (args ?? []) as readonly unknown[];
  const enc = (result: unknown) => encodeFunctionResult({ abi: EXCHANGE_ABI, functionName: name, result } as never);
  if (w.override) {
    const o = w.override(name);
    if (o) return { name, result: o };
  }
  switch (name) {
    case 'marketOf': {
      const m = w.markets.get(String(a[0]));
      const z = (n: number) => BigInt(n);
      return {
        name,
        result: enc({
          nOptions: m?.nOptions ?? 0,
          feeRate: Number(m?.feeRate ?? 0n),
          status: m?.status ?? 0,
          hasProposal: false,
          proposedOutcome: 0,
          finalOutcome: 0,
          tradingClose: m?.tradingClose ?? 0n,
          resolutionDeadline: (m?.tradingClose ?? 0n) + 86_400n,
          finalizableAt: 0n,
          positionCap: m?.positionCap ?? 0n,
          setsOutstanding: z(0),
          collateral: z(0),
          feesHeld: z(0),
          profitHeldTotal: z(0),
          unwindPool: z(0),
          evidenceHash: `0x${'0'.repeat(64)}`,
          rulesHash: `0x${'0'.repeat(64)}`,
        }),
      };
    }
    case 'nonces':
      return { name, result: enc(w.nonces.get(lower(a[0] as string)) ?? 0n) };
    case 'orders': {
      const s = w.orders.get(lower(a[0] as string)) ?? { filled: 0n, cancelled: false };
      return { name, result: enc([s.filled, s.cancelled]) };
    }
    case 'cash':
      return { name, result: enc(w.cash.get(lower(a[0] as string)) ?? 0n) };
    case 'positionOf':
      return { name, result: enc(w.positions.get(`${a[0]}:${a[1]}:${lower(a[2] as string)}`) ?? 0n) };
    case 'feeOf': {
      const m = w.markets.get(String(a[0]));
      const size = a[1] as bigint;
      const price = a[2] as bigint;
      const rate = m?.feeRate ?? 0n;
      // Plan 4.4: ceil(feeRate x size x t x (100 - t) / 10^8)
      const num = rate * size * price * (100n - price);
      return { name, result: enc((num + 10n ** 8n - 1n) / 10n ** 8n) };
    }
    case 'admin':
      return { name, result: enc(w.admin) };
    case 'resolver':
      return { name, result: enc(w.resolver) };
    case 'TREASURY':
      return { name, result: enc(w.treasury) };
    case 'isOperator':
      return { name, result: enc(w.operators.has(lower(a[0] as string))) };
    case 'isValidOrderSignature':
      return { name, result: enc(await modelIsValid(w, a)) };
    default:
      throw new Revert('0x');
  }
}

type RpcAnswer = { result: unknown } | { error: { code: number; message: string; data?: Hex } };

async function answer(w: World, method: string, params: unknown[]): Promise<RpcAnswer> {
  switch (method) {
    case 'eth_chainId':
      return { result: `0x${w.chainId.toString(16)}` };
    case 'eth_blockNumber':
      return { result: `0x${w.block.toString(16)}` };
    case 'eth_getCode':
      return { result: w.code.get(lower(params[0] as string)) ?? '0x' };
    case 'eth_getStorageAt': {
      const v = w.storage.get(`${lower(params[0] as string)}:${lower(params[1] as string)}`);
      return { result: v ?? `0x${'0'.repeat(64)}` };
    }
    case 'eth_getLogs': {
      const f = params[0] as { address: string; fromBlock: Hex; toBlock: Hex; topics: Hex[][] };
      const from = BigInt(f.fromBlock);
      const to = BigInt(f.toBlock);
      if (to - from + 1n > 100n) return { error: { code: -32600, message: 'block range too large' } };
      if (lower(f.address) !== lower(EXCHANGE)) return { result: [] };
      const want = new Set((f.topics[0] ?? []).map(lower));
      return {
        result: w.logs
          .filter((l) => l.block >= from && l.block <= to && want.has(lower(l.topics[0])))
          .map((l, i) => ({ address: EXCHANGE, topics: l.topics, data: l.data, blockNumber: `0x${l.block.toString(16)}`, logIndex: `0x${i.toString(16)}` })),
      };
    }
    case 'eth_call': {
      const tx = params[0] as { to: Hex; data: Hex; gas?: string };
      try {
        if (lower(tx.to) === lower(MULTICALL3)) {
          const { args } = decodeFunctionData({ abi: AGGREGATE3, data: tx.data });
          const inner = args![0] as readonly { target: Hex; allowFailure: boolean; callData: Hex }[];
          const out: { success: boolean; returnData: Hex }[] = [];
          for (const c of inner) {
            try {
              if (lower(c.target) !== lower(EXCHANGE)) throw new Revert('0x');
              const r = await exchangeCall(w, c.callData);
              w.inner.push(r.name);
              out.push({ success: true, returnData: r.result });
            } catch (e) {
              out.push({ success: false, returnData: e instanceof Revert ? e.data : '0x' });
            }
          }
          return { result: encodeFunctionResult({ abi: AGGREGATE3, functionName: 'aggregate3', result: out }) };
        }
        if (lower(tx.to) !== lower(EXCHANGE)) return { result: '0x' };
        const r = await exchangeCall(w, tx.data);
        return { result: r.result };
      } catch (e) {
        if (e instanceof Revert) return { error: { code: 3, message: 'execution reverted', data: e.data } };
        throw e;
      }
    }
    default:
      return { error: { code: -32601, message: 'method not found' } };
  }
}

/// The fake `fetch`: one JSON-RPC request per HTTP request.
export function makeFetch(w: World): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (Array.isArray(body)) {
      w.calls.push({ method: 'BATCH', batch: true });
      return new Response('Restricted JSON RPC method', { status: 403 });
    }
    const method = String(body.method);
    const params = (body.params ?? []) as unknown[];
    let name: string | undefined;
    if (method === 'eth_call') {
      const tx = params[0] as { to: Hex; data: Hex; gas?: string };
      if (lower(tx.to) === lower(MULTICALL3)) name = 'aggregate3';
      else {
        try {
          name = decodeFunctionData({ abi: EXCHANGE_ABI, data: tx.data }).functionName as string;
        } catch {
          name = undefined;
        }
      }
      w.calls.push({ method, name: name === 'aggregate3' ? 'aggregate3' : name, gas: tx.gas });
    } else {
      w.calls.push({ method });
    }
    const f = w.fail?.(method, name);
    if (f === 'down') return new Response('bad gateway', { status: 502 });
    if (f === 'rate') return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32011, message: 'limited' } }), { status: 200 });
    if (f === 'garbage') return new Response('<html>', { status: 200 });
    const a = await answer(w, method, params);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...a }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}
