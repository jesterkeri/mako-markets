// Adversary pass on feat/me-rounds 926d326 (rounds in Me: claims + totals). The real wagmi + TanStack hooks against
// a scripted custom transport built with viem's own encoder (the adversary-me-read-retry harness), answering both
// MakoMarketsV4 and MakoRoundsV1 calls, plain or inside Multicall3 aggregate3. Nothing here touches a network.
//
// Round values follow MakoRoundsV1 (mako-contracts/src/MakoRoundsV1.sol): a win pays
// floor(stake * distributable / winningPool), and `claim` also pays the creator fee to the round's creator when the
// round SETTLED and the fee is unclaimed (claim(), lines 742-791).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import * as React from 'react';
import { createConfig, custom, WagmiProvider } from 'wagmi';
import { decodeFunctionData, encodeFunctionResult, erc20Abi, getAddress, multicall3Abi, type Hex } from 'viem';

import { makoAbi } from '@/lib/MakoMarkets.abi';
import { MAKO_ADDRESS, MarketType, Outcome } from '@/lib/contract';
import { monadTestnet } from '@/lib/chain';
import { roundsAbi } from '@/lib/rounds-abi';

const ROUNDS = '0x00000000000000000000000000000000000000f0' as const;
const A = '0x00000000000000000000000000000000000000a5' as const;
const EOA = '0x00000000000000000000000000000000000000e0' as const;

vi.mock('@/lib/contract', async (orig) => ({ ...(await orig<typeof import('@/lib/contract')>()), ROUNDS_ADDRESS: '0x00000000000000000000000000000000000000f0' }));
vi.mock('@/lib/use-mako-labels', () => ({ useMakoLabelsBatch: () => ({ data: undefined }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('@/lib/use-user', () => ({
  USER_QUERY_KEY: ['user'],
  useUser: () => ({
    user: { authed: true, authType: 'magic', email: 'j@example.com', safeAddress: A, magicEoa: EOA, displayName: 'joshua', avatarUrl: null },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  accountAddress: (u: { safeAddress: string }) => u.safeAddress,
}));
const runSponsoredRequest = vi.fn();
vi.mock('@/lib/aa-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/aa-client')>('@/lib/aa-client');
  return { ...actual, runSponsoredRequest: (...a: unknown[]) => runSponsoredRequest(...a) };
});

const { MeClient } = await import('@/app/me/MeClient');
const { useMeData } = await import('@/app/me/use-me-data');

const USDC = 1_000_000n;
const NOW = Math.floor(Date.now() / 1000);
const MC3 = getAddress(monadTestnet.contracts.multicall3.address);

// One open pool, 4 USDC on YES: in play 4.00, nothing to claim.
const pool0 = {
  creator: '0x00000000000000000000000000000000000000c1' as const,
  mType: MarketType.CRYPTO,
  oracleRef: `0x${'00'.repeat(32)}` as Hex,
  question: 'Open pool?',
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
};

// A settled round as MakoRoundsV1 stores it: UP 2.00 / DOWN 1.00, UP won, fees 1% of 3.00 and 2% of 1.00.
function rawRound(over: Record<string, unknown> = {}) {
  return {
    creator: '0x00000000000000000000000000000000000000c2' as `0x${string}`,
    openTime: BigInt(NOW - 20_000),
    startTime: BigInt(NOW - 10_000),
    status: 2,
    outcome: 1,
    refundReason: 0,
    anchorPrice: 82_631_697_230_090_010_000_000n,
    closePrice: 82_803_526_460_810_000_000_000n,
    anchorObservedAt: 0,
    closeObservedAt: 0,
    anchorReportHash: `0x${'00'.repeat(32)}` as Hex,
    closeReportHash: `0x${'00'.repeat(32)}` as Hex,
    upPool: 2n * USDC,
    downPool: 1n * USDC,
    upEntrants: 1,
    downEntrants: 1,
    protocolFee: 30_000n,
    creatorFee: 20_000n,
    distributable: 2_950_000n,
    winnersClaimed: 0,
    paidOut: 0n,
    ...over,
  };
}

let rounds: ReturnType<typeof rawRound>[] = [];
/// side 1 = up, 2 = down, as MakoRoundsV1's Side enum.
let roundStakes: Record<string, { side: number; amount: bigint; claimed: boolean }> = {};
let creatorFeeClaimed: Record<string, boolean> = {};
let refuse: (fn: string, args: readonly unknown[]) => boolean = () => false;
const calls: string[] = [];

function answerMako(data: Hex): Hex {
  const { functionName, args = [] } = decodeFunctionData({ abi: makoAbi, data });
  calls.push(functionName);
  if (refuse(functionName, args)) throw new Error(`refused ${functionName}`);
  if (functionName === 'nextMarketId') return encodeFunctionResult({ abi: makoAbi, functionName, result: 1n });
  if (functionName === 'getMarket') return encodeFunctionResult({ abi: makoAbi, functionName, result: pool0 as never });
  if (functionName === 'getUserBet') {
    const who = (args[1] as string).toLowerCase();
    return encodeFunctionResult({ abi: makoAbi, functionName, result: who === A ? [4n * USDC, 0n, false] : [0n, 0n, false] });
  }
  throw new Error(`unscripted mako ${functionName}`);
}

function answerRounds(data: Hex): Hex {
  const { functionName, args = [] } = decodeFunctionData({ abi: roundsAbi, data });
  calls.push(functionName);
  if (refuse(functionName, args)) throw new Error(`refused ${functionName}`);
  const id = Number((args[0] as bigint | undefined) ?? 0n);
  if (functionName === 'roundCount') return encodeFunctionResult({ abi: roundsAbi, functionName, result: BigInt(rounds.length) });
  if (functionName === 'roundOf') return encodeFunctionResult({ abi: roundsAbi, functionName, result: rounds[id - 1] as never });
  const key = `${id}:${String(args[1]).toLowerCase()}`;
  const s = roundStakes[key] ?? { side: 0, amount: 0n, claimed: false };
  if (functionName === 'stakeOf') return encodeFunctionResult({ abi: roundsAbi, functionName, result: { side: s.side, amount: s.amount } as never });
  if (functionName === 'stakeClaimed') return encodeFunctionResult({ abi: roundsAbi, functionName, result: s.claimed });
  if (functionName === 'creatorFeeClaimed') return encodeFunctionResult({ abi: roundsAbi, functionName, result: creatorFeeClaimed[String(id)] ?? false });
  throw new Error(`unscripted rounds ${functionName}`);
}

function answer(target: string, data: Hex): Hex {
  if (getAddress(target) === getAddress(MAKO_ADDRESS)) return answerMako(data);
  if (getAddress(target) === getAddress(ROUNDS)) return answerRounds(data);
  return encodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', result: 50n * USDC });
}

async function request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
  if (method === 'eth_chainId') return `0x${monadTestnet.id.toString(16)}`;
  if (method !== 'eth_call') throw new Error(`unscripted ${method}`);
  const [{ to, data }] = params as [{ to: string; data: Hex }];
  if (getAddress(to) === MC3) {
    const { args } = decodeFunctionData({ abi: multicall3Abi, data });
    const inner = args[0] as readonly { target: string; callData: Hex }[];
    // A refused inner call refuses the whole eth_call, as the public RPC does.
    const out = inner.map((c) => ({ success: true, returnData: answer(c.target, c.callData) }));
    return encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: out });
  }
  return answer(to, data);
}

function makeWrapper() {
  const config = createConfig({
    chains: [monadTestnet],
    transports: { [monadTestnet.id]: custom({ request }, { retryCount: 0 }) },
    multiInjectedProviderDiscovery: false,
    ssr: false,
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retryDelay: 20 } } });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <WagmiProvider config={config} reconnectOnMount={false}>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
  return Wrapper;
}


type Chain = ReturnType<typeof useMeData>['chain'];
function summarise(c: Chain): string {
  if (c.status !== 'ready') return c.status;
  return `ready inPlay=${c.stats.inPlay} won=${c.stats.wonAllTime} roundClaims=${c.roundClaims.map((r) => `${r.round.id}:${r.claim}`).join(',')}`;
}
function track() {
  const Wrapper = makeWrapper();
  const seen: string[] = [];
  const hook = renderHook2(Wrapper, seen);
  return { ...hook, seen };
}
function renderHook2(Wrapper: ReturnType<typeof makeWrapper>, seen: string[]) {
  // A test probe: the box is written from render on purpose, to read the hook's latest value from the test.
  const box: { latest: ReturnType<typeof useMeData> | null } = { latest: null };
  function Probe() {
    const r = useMeData(A, NOW);
    // eslint-disable-next-line react-hooks/immutability -- test probe: exposes the hook's latest value to the test
    box.latest = r;
    seen.push(summarise(r.chain));
    return null;
  }
  render(<Wrapper><Probe /></Wrapper>);
  return { current: () => box.latest! };
}
const pause = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

beforeEach(() => {
  rounds = [rawRound()];
  roundStakes = { [`1:${A}`]: { side: 1, amount: 2n * USDC, claimed: false } };
  creatorFeeClaimed = {};
  refuse = () => false;
  calls.length = 0;
  onlineManager.setOnline(true);
  runSponsoredRequest.mockReset();
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
  // GET /api/me/rounds (feat/me-rounds-indexer): an indexer that has every round and lists them all, so Me reads every
  // round here exactly as it did before discovery existed.
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    const body = { roundIds: rounds.map((_, i) => String(i + 1)), indexedThrough: String(rounds.length) };
    return { ok: true, status: 200, json: async () => body } as Response;
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  onlineManager.setOnline(true);
});

describe('adversary: the claim sheet says what claim(roundId) pays (spec 1, "through the round confirm sheet")', () => {
  it('a house account that won its own round: claim pays payout + its unclaimed creator fee, and the sheet must say so', async () => {
    // This account created round #1 (on MakoRoundsV1's creator list) and also backed UP, which won.
    rounds = [rawRound({ creator: A })];
    const Wrapper = makeWrapper();
    render(<Wrapper><MeClient /></Wrapper>);
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Claim / }).length).toBeGreaterThan(0), { timeout: 4000 });

    // What MakoRoundsV1.claim(1) transfers to this account (claim(), lines 750-785):
    //   stake half: floor(2.00 * 2.95 / 2.00) = 2.95; creator fee half: Settled, msg.sender == creator, unclaimed = 0.02.
    const r = rounds[0];
    const stakePart = (2n * USDC * r.distributable) / r.upPool;
    const feePart = r.status === 2 && r.creator === A && !creatorFeeClaimed['1'] ? r.creatorFee : 0n;
    const pays = stakePart + feePart;
    expect(pays).toBe(2_970_000n);

    fireEvent.click(screen.getAllByRole('button', { name: /^Claim / })[0]);
    // The round page's own sheet for this account reads "Confirm · 2.97 USDC" (RoundClient.tsx claimAmount).
    expect(screen.getAllByRole('button', { name: /^Confirm · / }).map((b) => b.textContent)).toContain('Confirm · 2.97 USDC');
  });
});

describe('adversary: the rounds read is all-or-nothing (spec 4)', () => {
  const READY = `ready inPlay=${4n * USDC} won=2950000 roundClaims=1:2950000`;

  it('one refused stakeClaimed call is retried; never a ready total without it', async () => {
    let first = true;
    refuse = (fn) => {
      if (fn === 'stakeClaimed' && first) { first = false; return true; }
      return false;
    };
    const t = track();
    await waitFor(() => expect(summarise(t.current().chain)).toBe(READY));
    expect(first).toBe(false);
    expect(t.seen.filter((s) => s !== 'loading' && s !== READY)).toEqual([]);
  });

  it('a refetch refused on every retry keeps the last complete totals', async () => {
    const t = track();
    await waitFor(() => expect(summarise(t.current().chain)).toBe(READY));
    refuse = (fn) => fn === 'roundOf' || fn === 'roundCount';
    t.seen.length = 0;
    await act(async () => { t.current().refetch(); await new Promise((r) => setTimeout(r, 400)); });
    expect(t.seen.every((s) => s === READY)).toBe(true);
  });

  it('rounds read paused offline: loading, never pools-only totals', async () => {
    let first = true;
    refuse = (fn) => {
      if (fn === 'stakeOf' && first) { first = false; onlineManager.setOnline(false); return true; }
      return false;
    };
    const t = track();
    await pause(200);
    expect(first).toBe(false);
    expect(t.seen.filter((s) => s !== 'loading')).toEqual([]);
    onlineManager.setOnline(true);
    await waitFor(() => expect(summarise(t.current().chain)).toBe(READY));
  });

  it('a new round between reads: never the old list as complete with a wrong total', async () => {
    const t = track();
    await waitFor(() => expect(summarise(t.current().chain)).toBe(READY));
    rounds = [...rounds, rawRound({ status: 1, outcome: 0, startTime: BigInt(NOW + 3000), distributable: 0n })];
    roundStakes[`2:${A}`] = { side: 2, amount: 1n * USDC, claimed: false };
    t.seen.length = 0;
    await act(async () => { t.current().refetch(); await new Promise((r) => setTimeout(r, 100)); });
    await waitFor(() => expect(summarise(t.current().chain)).toBe(`ready inPlay=${5n * USDC} won=2950000 roundClaims=1:2950000`));
    expect(t.seen.filter((s) => s.startsWith('ready') && s !== READY && !s.includes(`inPlay=${5n * USDC}`))).toEqual([]);
  });
});

describe('adversary: refunds and sides through the real decoder (spec 1-3)', () => {
  it('tie (Refunded, Tie) pays the stake on either side; a one-sided unmarked round stays in play; a lost DOWN adds nothing', async () => {
    rounds = [
      rawRound({ status: 3, outcome: 0, refundReason: 2, protocolFee: 0n, creatorFee: 0n, distributable: 0n }),
      rawRound({ status: 1, outcome: 0, startTime: BigInt(NOW - 120), downPool: 0n, distributable: 0n }),
      rawRound(),
    ];
    roundStakes = {
      [`1:${A}`]: { side: 2, amount: 1n * USDC, claimed: false },
      [`2:${A}`]: { side: 1, amount: 3n * USDC, claimed: false },
      [`3:${A}`]: { side: 2, amount: 1n * USDC, claimed: false },
    };
    const t = track();
    await waitFor(() => expect(summarise(t.current().chain)).toBe(`ready inPlay=${7n * USDC} won=0 roundClaims=1:${1n * USDC}`));
  });
});
