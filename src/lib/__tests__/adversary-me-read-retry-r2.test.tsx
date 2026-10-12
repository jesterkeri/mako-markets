// Adversary pass r2 on 3230821 (useAllMarkets gates loading on the count query's isPending). Same harness as
// adversary-me-read-retry.test.tsx: the real wagmi hooks against a scripted custom transport built with viem's own
// encoder, which answers eth_call (Multicall3 aggregate3 and direct calls) and can refuse any call. Nothing here
// touches a network.
//
// Spec under attack (brief for fix/me-read-retry):
//   1. one refused call is retried and a failed refetch keeps the last complete data
//   2. totals never from a partial set, never zeros for unknown data; failed every retry with nothing read = error
//   3. useMarkets keeps its behaviour
//   4. a new pool neither computes totals from the old list as if complete nor shows the error
//   5. a genuinely zero-pool or zero-stake account shows real zeros once read, not a permanent loading

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import * as React from 'react';
import { createConfig, custom, WagmiProvider } from 'wagmi';
import { decodeFunctionData, encodeFunctionResult, getAddress, multicall3Abi, erc20Abi, type Hex } from 'viem';

import { makoAbi } from '@/lib/MakoMarkets.abi';
import { MAKO_ADDRESS, MarketType, Outcome } from '@/lib/contract';
import { monadTestnet } from '@/lib/chain';

vi.mock('@/lib/use-mako-labels', () => ({ useMakoLabelsBatch: () => ({ data: undefined }) }));

const { useMeData } = await import('@/app/me/use-me-data');

const USDC = 1_000_000n;
const NOW = Math.floor(Date.now() / 1000);
const A = '0x00000000000000000000000000000000000000a5' as const;
const B = '0x00000000000000000000000000000000000000b6' as const;
const MC3 = getAddress(monadTestnet.contracts.multicall3.address);

function rawPool(i: number, over: Record<string, unknown> = {}) {
  return {
    creator: '0x00000000000000000000000000000000000000c1' as const,
    mType: MarketType.CRYPTO,
    oracleRef: `0x${'00'.repeat(32)}` as Hex,
    question: `Question ${i}?`,
    createdAt: BigInt(NOW - 10 * 3600),
    closeTime: BigInt(NOW + 7200),
    bettingCloseTime: BigInt(NOW + 3600),
    totalYes: 30n * USDC,
    totalNo: 10n * USDC,
    yesBettorCount: 2,
    noBettorCount: 1,
    outcome: Outcome.UNRESOLVED,
    resolved: false,
    creatorFeeClaimed: false,
    protocolFeeBpsSnapshot: 100,
    creatorFeeBpsSnapshot: 200,
    ...over,
  };
}

// Scripted chain state.
let pools: ReturnType<typeof rawPool>[] = [];
let stakes: Record<string, readonly [bigint, bigint, boolean]> = {};
/// Return true to refuse this inner call (the whole eth_call carrying it is refused, as the RPC does).
let refuse: (fn: string, args: readonly unknown[]) => boolean = () => false;
const calls: string[] = [];

function answer(data: Hex): Hex {
  const { functionName, args = [] } = decodeFunctionData({ abi: makoAbi, data });
  calls.push(functionName);
  if (refuse(functionName, args)) throw new Error(`refused ${functionName}`);
  if (functionName === 'nextMarketId') return encodeFunctionResult({ abi: makoAbi, functionName, result: BigInt(pools.length) });
  if (functionName === 'getMarket') {
    const i = Number(args[0] as bigint);
    if (i >= pools.length) throw new Error('revert: no market');
    return encodeFunctionResult({ abi: makoAbi, functionName, result: pools[i] as never });
  }
  if (functionName === 'getUserBet') {
    const key = `${(args[0] as bigint).toString()}:${(args[1] as string).toLowerCase()}`;
    return encodeFunctionResult({ abi: makoAbi, functionName, result: stakes[key] ?? [0n, 0n, false] });
  }
  throw new Error(`unscripted ${functionName}`);
}

async function request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
  if (method === 'eth_chainId') return `0x${monadTestnet.id.toString(16)}`;
  if (method !== 'eth_call') throw new Error(`unscripted ${method}`);
  const [{ to, data }] = params as [{ to: string; data: Hex }];
  const target = getAddress(to);
  if (target === MC3) {
    const { args } = decodeFunctionData({ abi: multicall3Abi, data });
    const inner = args[0] as readonly { target: string; callData: Hex }[];
    const out = inner.map((c) => {
      if (getAddress(c.target) === getAddress(MAKO_ADDRESS)) return { success: true, returnData: answer(c.callData) };
      return { success: true, returnData: encodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', result: 50n * USDC }) };
    });
    return encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: out });
  }
  if (target === getAddress(MAKO_ADDRESS)) return answer(data);
  return encodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', result: 50n * USDC });
}

function makeWrapper() {
  const config = createConfig({
    chains: [monadTestnet],
    transports: { [monadTestnet.id]: custom({ request }, { retryCount: 0 }) },
    multiInjectedProviderDiscovery: false,
    ssr: false,
  });
  // TanStack defaults (retry: 3), only the backoff shortened so a test does not wait 7 seconds.
  const qc = new QueryClient({ defaultOptions: { queries: { retryDelay: 20 } } });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <WagmiProvider config={config} reconnectOnMount={false}>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
  return { Wrapper, qc };
}

type Chain = ReturnType<typeof useMeData>['chain'];
function summarise(c: Chain): string {
  if (c.status !== 'ready') return c.status;
  return `ready inPlay=${c.stats.inPlay} positions=${c.positions.length} created=${c.created}`;
}

function track(acct: `0x${string}` = A) {
  const { Wrapper, qc } = makeWrapper();
  const seen: string[] = [];
  const hook = renderHook(({ a }) => { const r = useMeData(a, NOW); seen.push(summarise(r.chain)); return r; }, { wrapper: Wrapper, initialProps: { a: acct } });
  return { ...hook, seen, qc };
}

const pause = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const READY_A = `ready inPlay=${10n * USDC} positions=2 created=0`;

beforeEach(() => {
  pools = [rawPool(0), rawPool(1)];
  stakes = { [`0:${A}`]: [4n * USDC, 0n, false], [`1:${A}`]: [6n * USDC, 0n, false] };
  refuse = () => false;
  calls.length = 0;
  onlineManager.setOnline(true);
});
afterEach(() => {
  cleanup();
  onlineManager.setOnline(true);
});

describe('adversary r2: paused reads at each step (3230821)', () => {
  it('count read paused offline: loading, never ready or error; reconnect reads the real totals', async () => {
    onlineManager.setOnline(false);
    const { result, seen } = track();
    await pause(150);
    expect(seen.filter((s) => s !== 'loading')).toEqual([]);
    onlineManager.setOnline(true);
    await waitFor(() => expect(summarise(result.current.chain)).toBe(READY_A));
    expect(seen.filter((s) => s !== 'loading' && s !== READY_A)).toEqual([]);
  });

  it('pool list paused offline after the count is known: loading, never "0 pools"; reconnect reads the real totals', async () => {
    let first = true;
    // The first getMarket read is refused and the browser goes offline before the retry, so the retry pauses.
    refuse = (fn) => {
      if (fn === 'getMarket' && first) { first = false; onlineManager.setOnline(false); return true; }
      return false;
    };
    const { result, seen } = track();
    await pause(200);
    expect(first).toBe(false);
    expect(result.current.chain.status).toBe('loading');
    expect(seen.filter((s) => s !== 'loading')).toEqual([]);
    onlineManager.setOnline(true);
    await waitFor(() => expect(summarise(result.current.chain)).toBe(READY_A));
    expect(seen.filter((s) => s !== 'loading' && s !== READY_A)).toEqual([]);
  });

  it('stake read paused offline: loading, never zero stakes; reconnect reads the real totals', async () => {
    let first = true;
    refuse = (fn) => {
      if (fn === 'getUserBet' && first) { first = false; onlineManager.setOnline(false); return true; }
      return false;
    };
    const { result, seen } = track();
    await pause(200);
    expect(first).toBe(false);
    expect(result.current.chain.status).toBe('loading');
    expect(seen.filter((s) => s !== 'loading')).toEqual([]);
    onlineManager.setOnline(true);
    await waitFor(() => expect(summarise(result.current.chain)).toBe(READY_A));
    expect(seen.filter((s) => s !== 'loading' && s !== READY_A)).toEqual([]);
  });

  it('offline after a complete read: the paused refetch keeps the last totals, no loading or error flash', async () => {
    const { result, seen } = track();
    await waitFor(() => expect(summarise(result.current.chain)).toBe(READY_A));
    onlineManager.setOnline(false);
    seen.length = 0;
    await act(async () => { result.current.refetch(); await new Promise((r) => setTimeout(r, 150)); });
    expect(seen.every((s) => s === READY_A)).toBe(true);
  });
});

describe('adversary r2: real zeros (spec 5)', () => {
  it('no pools on chain (count 0, list and stake queries disabled) reads as real zeros, not a permanent loading', async () => {
    pools = [];
    stakes = {};
    const { result } = track();
    await waitFor(() => expect(summarise(result.current.chain)).toBe('ready inPlay=0 positions=0 created=0'), { timeout: 2000 });
    expect(calls).not.toContain('getMarket');
  });

  it('pools exist but the account has no stake in any: real zeros once read', async () => {
    stakes = {};
    const { result, seen } = track();
    await waitFor(() => expect(summarise(result.current.chain)).toBe('ready inPlay=0 positions=0 created=0'));
    // The zero came from a stake read, never from an unread state.
    expect(calls).toContain('getUserBet');
    expect(seen.filter((s) => s.startsWith('ready'))).toEqual(seen.filter((s) => s === 'ready inPlay=0 positions=0 created=0'));
  });

  it('count 0 read while offline at first: loading until the count is read, then real zeros', async () => {
    pools = [];
    stakes = {};
    onlineManager.setOnline(false);
    const { result, seen } = track();
    await pause(150);
    expect(seen.filter((s) => s !== 'loading')).toEqual([]);
    onlineManager.setOnline(true);
    await waitFor(() => expect(summarise(result.current.chain)).toBe('ready inPlay=0 positions=0 created=0'));
  });
});

describe('adversary r2: error with data, new pools, account switching', () => {
  it('count refetch refused on every retry while the list is known keeps the last totals', async () => {
    const { result, seen } = track();
    await waitFor(() => expect(summarise(result.current.chain)).toBe(READY_A));
    refuse = (fn) => fn === 'nextMarketId';
    seen.length = 0;
    await act(async () => { result.current.refetch(); await new Promise((r) => setTimeout(r, 400)); });
    expect(seen.every((s) => s === READY_A)).toBe(true);
  });

  it('every read refused from the start, then the RPC recovers: the error clears by itself (refetchInterval)', async () => {
    refuse = (fn) => fn === 'nextMarketId';
    const { result } = track();
    await waitFor(() => expect(result.current.chain.status).toBe('error'), { timeout: 3000 });
    refuse = () => false;
    await waitFor(() => expect(summarise(result.current.chain)).toBe(READY_A), { timeout: 8000 });
  }, 12_000);

  it('a new pool while the browser goes offline before its list is read: loading, never the old list as complete', async () => {
    const { result, seen } = track();
    await waitFor(() => expect(summarise(result.current.chain)).toBe(READY_A));
    pools = [...pools, rawPool(2, { creator: A })];
    stakes[`2:${A}`] = [5n * USDC, 0n, false];
    let first = true;
    refuse = (fn) => {
      if (fn === 'getMarket' && first) { first = false; onlineManager.setOnline(false); return true; }
      return false;
    };
    seen.length = 0;
    await act(async () => { result.current.refetch(); await new Promise((r) => setTimeout(r, 200)); });
    expect(seen).not.toContain('error');
    expect(seen.filter((s) => s.startsWith('ready') && s !== READY_A)).toEqual([]);
    onlineManager.setOnline(true);
    await waitFor(() => expect(summarise(result.current.chain)).toBe(`ready inPlay=${15n * USDC} positions=3 created=1`));
  });

  it('switching account while offline never shows the previous account totals for the new one', async () => {
    stakes[`0:${B}`] = [1n * USDC, 0n, false];
    const { result, rerender, seen } = track();
    await waitFor(() => expect(summarise(result.current.chain)).toBe(READY_A));
    onlineManager.setOnline(false);
    seen.length = 0;
    rerender({ a: B });
    await pause(150);
    expect(seen.filter((s) => s.startsWith('ready'))).toEqual([]);
    onlineManager.setOnline(true);
    await waitFor(() => expect(summarise(result.current.chain)).toBe(`ready inPlay=${1n * USDC} positions=1 created=0`));
  });
});
