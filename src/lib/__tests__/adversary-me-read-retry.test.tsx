// Adversary pass on f7147fe (Me reads every pool all-or-nothing, retried by TanStack Query). The real wagmi hooks
// run against a scripted custom transport, built with viem's own encoder, that answers eth_call (Multicall3
// aggregate3 and direct calls) and can refuse any call. Nothing here touches a network.
//
// Spec under attack (brief for fix/me-read-retry):
//   1. one refused call is retried and a failed refetch keeps the last complete data
//   2. totals never from a partial set, never zeros for unknown data
//   3. useMarkets keeps its behaviour
//   4. a new pool neither computes totals from the old list as if complete nor shows the error

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import * as React from 'react';
import { createConfig, custom, WagmiProvider } from 'wagmi';
import { decodeFunctionData, encodeFunctionResult, getAddress, multicall3Abi, erc20Abi, type Hex } from 'viem';

import { makoAbi } from '@/lib/MakoMarkets.abi';
import { MAKO_ADDRESS, MarketType, Outcome } from '@/lib/contract';
import { monadTestnet } from '@/lib/chain';

vi.mock('@/lib/use-mako-labels', () => ({ useMakoLabelsBatch: () => ({ data: undefined }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('@/lib/use-user', () => ({
  USER_QUERY_KEY: ['user'],
  useUser: () => ({
    user: { authed: true, authType: 'magic', email: 'j@example.com', safeAddress: '0x00000000000000000000000000000000000000a5', magicEoa: '0x00000000000000000000000000000000000000e0', displayName: 'joshua', avatarUrl: null },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  accountAddress: (u: { safeAddress: string }) => u.safeAddress,
}));

const { useMeData } = await import('@/app/me/use-me-data');
const { useAllMarkets, useMarkets } = await import('@/lib/hooks');
const { MeClient } = await import('@/app/me/MeClient');

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

describe('adversary: Me reads every pool, all or nothing (f7147fe)', () => {
  it('reads the totals end to end through real wagmi (harness sanity)', async () => {
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useMeData(A, NOW), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.chain.status).toBe('ready'));
    expect(summarise(result.current.chain)).toBe(`ready inPlay=${10n * USDC} positions=2 created=0`);
  });

  it('spec 2: an unknown pool count (the count read paused, e.g. the browser offline) never renders as zero totals', async () => {
    onlineManager.setOnline(false);
    const { Wrapper } = makeWrapper();
    const seen: string[] = [];
    const { result } = renderHook(() => {
      const r = useMeData(A, NOW);
      seen.push(summarise(r.chain));
      return r;
    }, { wrapper: Wrapper });
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
    // Nothing has been read: the count is unknown, so the page may show loading or the error, never "0 pools".
    expect(seen.filter((s) => s.startsWith('ready'))).toEqual([]);
    expect(result.current.chain.status).not.toBe('ready');
  });

  it('spec 2, rendered: the Me page shows no "0.00 USDC" In play while the pool count is unknown (count read paused offline)', async () => {
    onlineManager.setOnline(false);
    const { Wrapper } = makeWrapper();
    render(<Wrapper><MeClient /></Wrapper>);
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
    // A stake of 10 USDC exists on chain; nothing has been read, so "0.00" is a claim the page cannot make.
    const cell = screen.getByText('IN PLAY').parentElement!;
    expect(cell.textContent!.slice('IN PLAY'.length)).not.toMatch(/^0\.00/);
    const won = screen.getByText('WON ALL TIME').parentElement!;
    expect(won.textContent!.slice('WON ALL TIME'.length)).not.toMatch(/^0\.00/);
  });

  it('spec 1: one refused getMarket call is retried, never shown as the error', async () => {
    let refusedOnce = false;
    refuse = (fn) => {
      if (fn === 'getMarket' && !refusedOnce) { refusedOnce = true; return true; }
      return false;
    };
    const { Wrapper } = makeWrapper();
    const seen: string[] = [];
    const { result } = renderHook(() => { const r = useMeData(A, NOW); seen.push(summarise(r.chain)); return r; }, { wrapper: Wrapper });
    await waitFor(() => expect(result.current.chain.status).toBe('ready'));
    expect(refusedOnce).toBe(true);
    expect(seen).not.toContain('error');
    expect(summarise(result.current.chain)).toBe(`ready inPlay=${10n * USDC} positions=2 created=0`);
  });

  it('spec 1: one refused getUserBet call is retried, never shown as the error', async () => {
    let refusedOnce = false;
    refuse = (fn) => {
      if (fn === 'getUserBet' && !refusedOnce) { refusedOnce = true; return true; }
      return false;
    };
    const { Wrapper } = makeWrapper();
    const seen: string[] = [];
    const { result } = renderHook(() => { const r = useMeData(A, NOW); seen.push(summarise(r.chain)); return r; }, { wrapper: Wrapper });
    await waitFor(() => expect(result.current.chain.status).toBe('ready'));
    expect(refusedOnce).toBe(true);
    expect(seen).not.toContain('error');
  });

  it('spec 2: every retry refused with nothing read shows the error, not zeros', async () => {
    refuse = (fn) => fn === 'getMarket';
    const { Wrapper } = makeWrapper();
    const seen: string[] = [];
    const { result } = renderHook(() => { const r = useMeData(A, NOW); seen.push(summarise(r.chain)); return r; }, { wrapper: Wrapper });
    await waitFor(() => expect(result.current.chain.status).toBe('error'), { timeout: 3000 });
    expect(seen.filter((s) => s.startsWith('ready'))).toEqual([]);
    // 1 try + 3 retries, each a multicall then wagmi's per-call fallback.
    expect(calls.filter((c) => c === 'getMarket').length).toBeGreaterThanOrEqual(4);
  });

  it('spec 1: a refetch refused on every retry keeps the last complete totals', async () => {
    const { Wrapper } = makeWrapper();
    const seen: string[] = [];
    const { result } = renderHook(() => { const r = useMeData(A, NOW); seen.push(summarise(r.chain)); return r; }, { wrapper: Wrapper });
    await waitFor(() => expect(result.current.chain.status).toBe('ready'));
    const before = summarise(result.current.chain);
    refuse = () => true;
    seen.length = 0;
    await act(async () => { result.current.refetch(); await new Promise((r) => setTimeout(r, 600)); });
    expect(seen.every((s) => s === before)).toBe(true);
  });

  it('spec 4: a new pool never shows the error nor old-list totals as complete', async () => {
    const { Wrapper } = makeWrapper();
    const seen: string[] = [];
    const { result } = renderHook(() => { const r = useMeData(A, NOW); seen.push(summarise(r.chain)); return r; }, { wrapper: Wrapper });
    await waitFor(() => expect(result.current.chain.status).toBe('ready'));
    pools = [...pools, rawPool(2, { creator: A })];
    stakes[`2:${A}`] = [5n * USDC, 0n, false];
    seen.length = 0;
    await act(async () => { result.current.refetch(); });
    await waitFor(() => expect(summarise(result.current.chain)).toBe(`ready inPlay=${15n * USDC} positions=3 created=1`));
    expect(seen).not.toContain('error');
    const readies = seen.filter((s) => s.startsWith('ready'));
    const allowed = [`ready inPlay=${10n * USDC} positions=2 created=0`, `ready inPlay=${15n * USDC} positions=3 created=1`];
    expect(readies.filter((s) => !allowed.includes(s))).toEqual([]);
  });

  it('switching accounts never shows the previous account stakes, and a refused new read is the error not zeros', async () => {
    const { Wrapper } = makeWrapper();
    const seen: string[] = [];
    const { result, rerender } = renderHook(({ acct }) => { const r = useMeData(acct, NOW); seen.push(summarise(r.chain)); return r; }, { wrapper: Wrapper, initialProps: { acct: A as `0x${string}` } });
    await waitFor(() => expect(result.current.chain.status).toBe('ready'));
    refuse = (fn, args) => fn === 'getUserBet' && (args[1] as string).toLowerCase() === B;
    seen.length = 0;
    rerender({ acct: B });
    await waitFor(() => expect(result.current.chain.status).toBe('error'), { timeout: 3000 });
    expect(seen.filter((s) => s.startsWith('ready'))).toEqual([]);
  });

  it('spec 3: useMarkets and useAllMarkets on one QueryClient do not share a cache entry of the other shape', async () => {
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => ({ all: useAllMarkets(), legacy: useMarkets() }), { wrapper: Wrapper });
    await waitFor(() => {
      expect(result.current.all.markets.length).toBe(2);
      expect(result.current.legacy.markets.length).toBe(2);
    });
    expect(result.current.all.markets.map((m) => m.question)).toEqual(['Question 0?', 'Question 1?']);
    expect(result.current.legacy.markets.map((m) => m.question)).toEqual(['Question 0?', 'Question 1?']);
    expect(result.current.all.markets[0].totalYes).toBe(30n * USDC);
  });
});
