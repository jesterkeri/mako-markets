// Adversary pass on da95010 (discovery refetchInterval 30 s -> 120 s, staleTime 120 s), against the brief's spec:
// (3) a claim or explicit refetch asks the indexer immediately, staleTime notwithstanding; (4) at most one discovery
// request per 2 minutes per open Me page, across focus changes, remounts and two Me components at once; (1)/(2) a
// discovery up to 2 minutes old still plans a read of every round the account may have entered or created since.
// The chain is scripted (roundCount 0, or the planner alone) so the only thing counted is the discovery request; its
// answer is the route's own wire shape (MeRoundsDiscoveryWire) for an indexer with no rounds.

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider, focusManager, onlineManager } from '@tanstack/react-query';
import * as React from 'react';
import { createConfig, custom, WagmiProvider } from 'wagmi';
import { decodeFunctionData, encodeFunctionResult, getAddress, multicall3Abi, type Hex } from 'viem';

import { monadTestnet } from '@/lib/chain';
import { planMeRoundReads, type MeRoundsDiscovery, type MeRoundsDiscoveryWire } from '@/lib/me-rounds-discovery';
import { roundsAbi } from '@/lib/rounds-abi';

vi.mock('@/lib/contract', async (orig) => ({ ...(await orig<typeof import('@/lib/contract')>()), ROUNDS_ADDRESS: '0x00000000000000000000000000000000000000f0' }));

const { useMeRounds, ME_ROUNDS_DISCOVERY_POLL_MS } = await import('@/lib/use-me-rounds');

const A = '0xe490ab83c7f247bec7d5e04ce04bc48d6609b550' as const;
const MC3 = getAddress(monadTestnet.contracts.multicall3.address);
const EMPTY: MeRoundsDiscoveryWire = { roundIds: [], indexedThrough: '0', head: null };

/// Fake-clock time of every discovery request the browser made.
let discoveryAt: number[] = [];

function answerRounds(data: Hex): Hex {
  const { functionName } = decodeFunctionData({ abi: roundsAbi, data });
  if (functionName === 'roundCount') return encodeFunctionResult({ abi: roundsAbi, functionName, result: 0n });
  throw new Error(`unscripted rounds ${functionName}`);
}

/// The chain: no rounds yet. Calls may arrive alone or batched through Multicall3, as wagmi sends them.
async function request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
  if (method === 'eth_chainId') return `0x${monadTestnet.id.toString(16)}`;
  if (method !== 'eth_call') throw new Error(`unscripted ${method}`);
  const [{ to, data }] = params as [{ to: string; data: Hex }];
  if (getAddress(to) === MC3) {
    const { args } = decodeFunctionData({ abi: multicall3Abi, data });
    const inner = args[0] as readonly { target: string; callData: Hex }[];
    const out = inner.map((c) => ({ success: true, returnData: answerRounds(c.callData) }));
    return encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: out });
  }
  return answerRounds(data);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  discoveryAt = [];
  onlineManager.setOnline(true);
  focusManager.setFocused(true);
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('/api/me/rounds?')) throw new Error(`unscripted fetch ${url}`);
    discoveryAt.push(Date.now());
    return new Response(JSON.stringify(EMPTY), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch);
});
afterEach(() => {
  cleanup();
  focusManager.setFocused(undefined);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

function makeWrapper() {
  const config = createConfig({
    chains: [monadTestnet],
    transports: { [monadTestnet.id]: custom({ request }, { retryCount: 0 }) },
    multiInjectedProviderDiscovery: false,
    ssr: false,
  });
  // The app's own QueryClient defaults (src/components/Providers.tsx: staleTime 30 s, everything else default).
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000 } } });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <WagmiProvider config={config} reconnectOnMount={false}>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
  return Wrapper;
}
const settle = async () => { for (let i = 0; i < 20; i++) await advance(50); };
/// Seconds since `t0` of each discovery request, and the smallest gap between two of them.
function gapsSince(t0: number) {
  const at = discoveryAt.map((ms) => (ms - t0) / 1000);
  return { at, min: Math.min(...at.slice(1).map((s, i) => s - at[i])) };
}

it('spec 4: a focus regained just before an interval tick does not cost a second discovery request within 2 minutes', async () => {
  expect(ME_ROUNDS_DISCOVERY_POLL_MS).toBe(120_000);
  const wrapper = makeWrapper();
  const t0 = Date.now();
  const { result } = renderHook(() => useMeRounds(A), { wrapper });
  await settle();
  expect(result.current.status).toBe('ready');
  expect(discoveryAt.length).toBe(1);

  await advance(124_000); // t = 125 s: the 120 s tick asked once
  expect(discoveryAt.length).toBe(2);

  // Hidden across the 240 s tick (skipped while unfocused), back at 358 s, 2 s before the 360 s tick.
  act(() => focusManager.setFocused(false));
  await advance(233_000);
  expect(discoveryAt.length).toBe(2);
  act(() => focusManager.setFocused(true));
  await advance(130_000); // t = 488 s

  const g = gapsSince(t0);
  expect(g.at.length).toBeGreaterThanOrEqual(3);
  expect(g.min, `discovery requests at seconds ${g.at.join(', ')}`).toBeGreaterThanOrEqual(120);
});

it('spec 4: two Me components mounted 60 s apart share one discovery schedule', async () => {
  const wrapper = makeWrapper();
  const t0 = Date.now();
  function Two({ second }: { second: boolean }) {
    useMeRounds(A);
    return second ? <Second /> : null;
  }
  function Second() {
    useMeRounds(A);
    return null;
  }
  const { rerender } = render(<Two second={false} />, { wrapper });
  await settle();
  await advance(59_000);
  rerender(<Two second />);
  await advance(600_000); // ten minutes
  const g = gapsSince(t0);
  expect(g.min, `discovery requests at seconds ${g.at.join(', ')}`).toBeGreaterThanOrEqual(120);
  expect(discoveryAt.length).toBeGreaterThanOrEqual(5);
  expect(discoveryAt.length).toBeLessThanOrEqual(1 + Math.floor(660 / 120));
});

it('spec 4: a remount within 2 minutes reuses the answer; spec 3: an explicit refetch asks at once', async () => {
  const wrapper = makeWrapper();
  const first = renderHook(() => useMeRounds(A), { wrapper });
  await settle();
  expect(discoveryAt.length).toBe(1);
  first.unmount();
  await advance(60_000);
  const second = renderHook(() => useMeRounds(A), { wrapper });
  await settle();
  expect(discoveryAt.length).toBe(1);
  expect(second.result.current.status).toBe('ready');

  // A claim lands 5 s later (MeClient calls data.refetch()): the answer is 66 s old, still fresh, and is asked anyway.
  await advance(5_000);
  await act(async () => { second.result.current.refetch(); });
  await settle();
  expect(discoveryAt.length).toBe(2);
});

it('spec 1 and 2: a 2-minute-old discovery still plans every round entered or created since, 30 rounds later', () => {
  // At discovery: 100 rounds on chain, the indexer through 98, rounds 89..98 still Active there; the account has an
  // old unclaimed round 40 and an entry in 93. Head fingerprint values are placeholders the planner never compares.
  const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => BigInt(a + i));
  const stale: MeRoundsDiscovery = {
    roundIds: [40n, ...range(89, 98)],
    indexedThrough: 98n,
    head: { id: 98n, openTime: 1n, startTime: 2n, creator: A },
  };
  // Two minutes later: 30 more rounds (well past the newest-12 window). Since the discovery the account entered 95
  // (Active at discovery), 99 (above the indexer's head, now outside the newest 12), 110, and created 130.
  const plan = planMeRoundReads(130n, stale);
  expect(plan.ok).toBe(true);
  const ids = plan.ok ? plan.ids : [];
  for (const id of [40n, 93n, 95n, 98n, 99n, 110n, 130n]) expect(ids).toContain(id);
  // A fresher discovery whose head is past a 10 s old roundCount is refused (Me shows unavailable), never a partial list.
  expect(planMeRoundReads(130n, { ...stale, indexedThrough: 131n, head: { ...stale.head!, id: 131n } }).ok).toBe(false);
});
