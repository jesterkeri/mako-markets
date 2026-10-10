// One-request market loading (plan r14 §4.1): request shape, the cap, and every failure isolated to the right scope.
import { decodeFunctionData, encodeFunctionResult, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { makoAbi } from '../src/abi';
import { AGGREGATES_PER_REQUEST, CALLS_PER_AGGREGATE, idsToRead, MAX_MARKETS, MULTICALL3, readMarkets } from '../src/market-reads';

const MAKO = '0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195' as const;
const BLOCK = 69797133n;

const aggregate3Abi = [
  {
    type: 'function',
    name: 'aggregate3',
    stateMutability: 'payable',
    inputs: [{ name: 'calls', type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'allowFailure', type: 'bool' }, { name: 'callData', type: 'bytes' }] }],
    outputs: [{ name: 'returnData', type: 'tuple[]', components: [{ name: 'success', type: 'bool' }, { name: 'returnData', type: 'bytes' }] }],
  },
] as const;

const market = (id: bigint, closeTime = 1_791_580_929n) => ({
  creator: '0x0C3f786653B81FdE81820260C9E1C60dA02CF6A6',
  mType: 1,
  oracleRef: '0x5355493a67743a312e3200000000000000000000000000000000000000000000',
  question: `market ${id}`,
  createdAt: closeTime - 600n,
  closeTime,
  bettingCloseTime: closeTime - 300n,
  totalYes: 1_000_000n,
  totalNo: 1_000_000n,
  yesBettorCount: 1,
  noBettorCount: 1,
  outcome: 0,
  resolved: false,
  creatorFeeClaimed: false,
  protocolFeeBpsSnapshot: 100,
  creatorFeeBpsSnapshot: 200,
});
const encodeResult = encodeFunctionResult as unknown as (p: { abi: readonly unknown[]; functionName: string; result: unknown }) => Hex;
const encodeMarket = (m: ReturnType<typeof market>) => encodeResult({ abi: makoAbi, functionName: 'getMarket', result: m });
/// What V4 returns for an id that does not exist: the zero struct (spike, 2026-10-10).
const ZERO = { ...market(0n), creator: '0x0000000000000000000000000000000000000000', oracleRef: `0x${'0'.repeat(64)}`, question: '', createdAt: 0n, closeTime: 0n, bettingCloseTime: 0n, totalYes: 0n, totalNo: 0n, yesBettorCount: 0, noBettorCount: 0, protocolFeeBpsSnapshot: 0, creatorFeeBpsSnapshot: 0 };

type Item = { id: number; method: string; params: [{ to: string; data: Hex }, string] };
/// A fake JSON-RPC endpoint: decodes each aggregate3, answers per id through `answer`.
function fakeRpc(answer: (id: bigint) => 'ok' | 'fail' | 'zero', opts: { status?: boolean; mangle?: (items: unknown[]) => unknown; pad?: number } = {}) {
  const seen: Item[][] = [];
  const post = async (body: string) => {
    const items = JSON.parse(body) as Item[];
    seen.push(items);
    const out = items.map((item) => {
      const { args } = decodeFunctionData({ abi: aggregate3Abi, data: item.params[0].data });
      const results = (args[0] as readonly { callData: Hex }[]).map((c) => {
        const id = (decodeFunctionData({ abi: makoAbi as never, data: c.callData }).args as readonly bigint[])[0];
        const a = answer(id);
        if (a === 'fail') return { success: false, returnData: '0x' as Hex };
        return { success: true, returnData: encodeMarket(a === 'zero' ? ZERO : market(id)) };
      });
      return { jsonrpc: '2.0', id: item.id, result: encodeFunctionResult({ abi: aggregate3Abi, functionName: 'aggregate3', result: results }) };
    });
    const text = JSON.stringify(opts.mangle ? opts.mangle(out) : out) + ' '.repeat(opts.pad ?? 0);
    return { ok: opts.status ?? true, text };
  };
  return { post, seen };
}
const ids = (n: number, from = 0) => Array.from({ length: n }, (_, i) => BigInt(from + i));

describe('which ids', () => {
  it('reads all of them up to the cap, then the newest 2,000 and says so', () => {
    expect(idsToRead(108n)).toEqual({ ids: ids(108), capExceeded: false });
    const big = idsToRead(2_100n);
    expect(big.ids).toHaveLength(MAX_MARKETS);
    expect(big.ids[0]).toBe(100n);
    expect(big.capExceeded).toBe(true);
  });
});

describe('request shape', () => {
  it('50 calls per aggregate, 4 aggregates per request, every call at the same block through Multicall3', async () => {
    const rpc = fakeRpc(() => 'ok');
    const out = await readMarkets({ post: rpc.post, mako: MAKO, marketAbi: makoAbi, ids: ids(450), block: BLOCK });
    expect(out.requests).toBe(3);
    expect(rpc.seen.map((r) => r.length)).toEqual([4, 4, 1]);
    for (const req of rpc.seen) {
      for (const item of req) {
        expect(item.method).toBe('eth_call');
        expect(item.params[0].to).toBe(MULTICALL3);
        expect(item.params[1]).toBe(`0x${BLOCK.toString(16)}`);
        const calls = decodeFunctionData({ abi: aggregate3Abi, data: item.params[0].data }).args[0] as readonly { allowFailure: boolean }[];
        expect(calls.length).toBeLessThanOrEqual(CALLS_PER_AGGREGATE);
        expect(calls.every((c) => c.allowFailure)).toBe(true);
      }
    }
    expect(out.reads.filter((r) => r.ok)).toHaveLength(450);
    expect(out.reads.map((r) => r.id)).toEqual(ids(450));
    expect(CALLS_PER_AGGREGATE * AGGREGATES_PER_REQUEST).toBe(200);
  });

  it('stops at 10 requests', async () => {
    const rpc = fakeRpc(() => 'ok');
    const out = await readMarkets({ post: rpc.post, mako: MAKO, marketAbi: makoAbi, ids: ids(2_500), block: BLOCK });
    expect(out.requests).toBe(10);
    expect(out.reads).toHaveLength(2_000);
  });
});

describe('failures stay in their scope', () => {
  it('a failed call marks only its market; a missing id (zero struct) is not a market', async () => {
    const rpc = fakeRpc((id) => (id === 3n ? 'fail' : id === 7n ? 'zero' : 'ok'));
    const out = await readMarkets<ReturnType<typeof market>>({ post: rpc.post, mako: MAKO, marketAbi: makoAbi, ids: ids(10), block: BLOCK });
    const by = new Map(out.reads.map((r) => [r.id, r]));
    expect(by.get(3n)).toEqual({ id: 3n, ok: false, reason: 'market_read_failed' });
    expect(by.get(7n)).toEqual({ id: 7n, ok: false, reason: 'market_read_failed' });
    expect(out.reads.filter((r) => r.ok)).toHaveLength(8);
    const five = by.get(5n);
    expect(five?.ok && five.market.question).toBe('market 5');
  });

  it.each([
    ['an HTTP error', { status: false }],
    ['a response over 1 MB', { pad: 1_000_001 }],
    ['a body that is not JSON', { mangle: () => '{{' }],
    ['the wrong number of answers', { mangle: (items: unknown[]) => items.slice(1) }],
  ])('%s marks every market of that request unavailable, and the next request still runs', async (_name, opts) => {
    let n = 0;
    const bad = fakeRpc(() => 'ok', opts as never);
    const good = fakeRpc(() => 'ok');
    const post = (body: string) => (n++ === 0 ? bad.post(body) : good.post(body));
    const out = await readMarkets({ post, mako: MAKO, marketAbi: makoAbi, ids: ids(250), block: BLOCK });
    expect(out.reads.slice(0, 200).every((r) => !r.ok && r.reason === 'markets_unavailable')).toBe(true);
    expect(out.reads.slice(200).every((r) => r.ok)).toBe(true);
  });

  it('a JSON-RPC error on one aggregate marks only that aggregate’s markets', async () => {
    const rpc = fakeRpc(() => 'ok', { mangle: (items) => items.map((it, i) => (i === 1 ? { jsonrpc: '2.0', id: 1, error: { code: -32011, message: 'rate' } } : it)) });
    const out = await readMarkets({ post: rpc.post, mako: MAKO, marketAbi: makoAbi, ids: ids(150), block: BLOCK });
    expect(out.reads.slice(50, 100).every((r) => !r.ok && r.reason === 'markets_unavailable')).toBe(true);
    expect(out.reads.filter((r) => r.ok)).toHaveLength(100);
  });

  it('a network failure marks the request unavailable instead of throwing', async () => {
    const out = await readMarkets({
      post: async () => {
        throw new TypeError('fetch failed');
      },
      mako: MAKO,
      marketAbi: makoAbi,
      ids: ids(5),
      block: BLOCK,
    });
    expect(out.reads.every((r) => !r.ok && r.reason === 'markets_unavailable')).toBe(true);
  });
});
