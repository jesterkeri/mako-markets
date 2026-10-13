// Adversary pass r2 on feat/me-rounds b1c1c9f (a round host's creator fee in Me), reusing the r1 harness. The real wagmi + TanStack hooks against
// a scripted custom transport built with viem's own encoder (the adversary-me-read-retry harness), answering both
// MakoMarketsV4 and MakoRoundsV1 calls, plain or inside Multicall3 aggregate3. Nothing here touches a network.
//
// Round values follow MakoRoundsV1 (mako-contracts/src/MakoRoundsV1.sol): a win pays
// floor(stake * distributable / winningPool), and `claim` also pays the creator fee to the round's creator when the
// round SETTLED and the fee is unclaimed (claim(), lines 742-791).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import * as React from 'react';
import { createConfig, custom, WagmiProvider } from 'wagmi';
import { decodeFunctionData, encodeFunctionResult, erc20Abi, getAddress, multicall3Abi, type Hex } from 'viem';

import { makoAbi } from '@/lib/MakoMarkets.abi';
import { MAKO_ADDRESS, MarketType, Outcome } from '@/lib/contract';
import { monadTestnet } from '@/lib/chain';
import { roundsAbi } from '@/lib/rounds-abi';

const ROUNDS = '0x00000000000000000000000000000000000000f0' as const;
// The signed-in account, lowercase with hex letters, so a casing mismatch against roundOf's checksummed creator shows.
const A = '0xe490ab83c7f247bec7d5e04ce04bc48d6609b550' as const;
const EOA = '0x00000000000000000000000000000000000000e0' as const;

vi.mock('@/lib/contract', async (orig) => ({ ...(await orig<typeof import('@/lib/contract')>()), ROUNDS_ADDRESS: '0x00000000000000000000000000000000000000f0' }));
vi.mock('@/lib/use-mako-labels', () => ({ useMakoLabelsBatch: () => ({ data: undefined }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('@/lib/use-user', () => ({
  USER_QUERY_KEY: ['user'],
  useUser: () => ({
    user: { authed: true, authType: 'magic', email: 'j@example.com', safeAddress: '0xe490ab83c7f247bec7d5e04ce04bc48d6609b550', magicEoa: EOA, displayName: 'joshua', avatarUrl: null },
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

// What MakoRoundsV1.claim(roundId) transfers to `who` (claim(), lines 742-791), restated from the Solidity so each
// expectation is the contract's answer, not the client's. null = the call reverts (RoundNotTerminal or NothingOwed).
function contractPays(id: number, who: string): bigint | null {
  const r = rounds[id - 1];
  if (r.status !== 2 && r.status !== 3) return null;
  const s = roundStakes[`${id}:${who.toLowerCase()}`] ?? { side: 0, amount: 0n, claimed: false };
  let stakePart = 0n;
  if (s.amount !== 0n && !s.claimed) {
    if (r.status === 3) stakePart = s.amount;
    else if (s.side === (r.outcome === 1 ? 1 : 2)) stakePart = (s.amount * r.distributable) / (r.outcome === 1 ? r.upPool : r.downPool);
  }
  const feePart = r.status === 2 && r.creator.toLowerCase() === who.toLowerCase() && !creatorFeeClaimed[String(id)] ? r.creatorFee : 0n;
  const owed = stakePart + feePart;
  return owed === 0n ? null : owed;
}
const CHECKSUMMED = getAddress(A);

describe('adversary r2: a host sees exactly what claim(roundId) pays (spec 1-3, 5)', () => {
  it('casing: roundOf returns a checksummed creator, the account is lowercase; a host with no stake still claims its fee', async () => {
    expect(CHECKSUMMED).not.toBe(A);
    rounds = [rawRound({ creator: CHECKSUMMED })];
    roundStakes = {};
    expect(contractPays(1, A)).toBe(20_000n);
    const t = track();
    await waitFor(() => expect(summarise(t.current().chain)).toBe(`ready inPlay=${4n * USDC} won=0 roundClaims=1:20000`));
  });

  it('a host with a losing stake: fee only; won all time excludes the fee', async () => {
    rounds = [rawRound({ creator: CHECKSUMMED })];
    roundStakes = { [`1:${A}`]: { side: 2, amount: 1n * USDC, claimed: false } };
    expect(contractPays(1, A)).toBe(20_000n);
    const t = track();
    await waitFor(() => expect(summarise(t.current().chain)).toBe(`ready inPlay=${4n * USDC} won=0 roundClaims=1:20000`));
  });

  it('a host that won: payout + fee; won all time is the payout only', async () => {
    rounds = [rawRound({ creator: CHECKSUMMED })];
    expect(contractPays(1, A)).toBe(2_970_000n);
    const t = track();
    await waitFor(() => expect(summarise(t.current().chain)).toBe(`ready inPlay=${4n * USDC} won=2950000 roundClaims=1:2970000`));
  });

  it('a host whose fee is claimed: nothing to claim and no row (contract reverts NothingOwed)', async () => {
    rounds = [rawRound({ creator: CHECKSUMMED })];
    roundStakes = {};
    creatorFeeClaimed = { '1': true };
    expect(contractPays(1, A)).toBeNull();
    const t = track();
    await waitFor(() => expect(summarise(t.current().chain)).toBe(`ready inPlay=${4n * USDC} won=0 roundClaims=`));
  });

  it('a settled round whose creator fee floored to 0: no claim for a host without a stake (NothingOwed)', async () => {
    // smaller pool 49 base units: floor(49 * CREATOR_FEE_BPS / 10_000) = 0 for any bps below 205.
    rounds = [rawRound({ creator: CHECKSUMMED, downPool: 49n, creatorFee: 0n, protocolFee: 20_000n, distributable: 1_980_049n })];
    roundStakes = {};
    expect(contractPays(1, A)).toBeNull();
    const t = track();
    await waitFor(() => expect(summarise(t.current().chain)).toBe(`ready inPlay=${4n * USDC} won=0 roundClaims=`));
  });

  it('tie, one-sided and no-price refunds for a host: the stake only, never a fee', async () => {
    // A refunded round stores creatorFee 0 in the contract; a nonzero one here proves the client does not read it.
    rounds = [1, 2, 3].map((reason) => rawRound({ creator: CHECKSUMMED, status: 3, outcome: 0, refundReason: reason, creatorFee: 20_000n }));
    roundStakes = {
      [`1:${A}`]: { side: 1, amount: 1n * USDC, claimed: false },
      [`2:${A}`]: { side: 2, amount: 3n * USDC, claimed: false },
    };
    expect([1, 2, 3].map((id) => contractPays(id, A))).toEqual([1n * USDC, 3n * USDC, null]);
    const t = track();
    await waitFor(() => expect(summarise(t.current().chain)).toBe(`ready inPlay=${4n * USDC} won=0 roundClaims=2:${3n * USDC},1:${1n * USDC}`));
  });

  it('a non-host on a hosted round: unchanged (payout only, no fee)', async () => {
    rounds = [rawRound()];
    expect(contractPays(1, A)).toBe(2_950_000n);
    const t = track();
    await waitFor(() => expect(summarise(t.current().chain)).toBe(`ready inPlay=${4n * USDC} won=2950000 roundClaims=1:2950000`));
  });
});

describe('adversary r2: the row, the sheet and the total for a host', () => {
  it('fee-only row reads as a house fee; the buttons and the sheet equal what claim pays', async () => {
    rounds = [rawRound({ creator: CHECKSUMMED }), rawRound({ creator: CHECKSUMMED })];
    roundStakes = { [`1:${A}`]: { side: 2, amount: 1n * USDC, claimed: false }, [`2:${A}`]: { side: 1, amount: 2n * USDC, claimed: false } };
    expect([contractPays(1, A), contractPays(2, A)]).toEqual([20_000n, 2_970_000n]);
    const Wrapper = makeWrapper();
    render(<Wrapper><MeClient /></Wrapper>);
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Claim / }).length).toBeGreaterThan(0), { timeout: 4000 });
    const buttons = screen.getAllByRole('button', { name: /^Claim / }).map((b) => b.textContent);
    expect(buttons).toContain('Claim 0.02 USDC');
    expect(buttons).toContain('Claim 2.97 USDC');
    expect(screen.getAllByText('House fee · round you hosted').length).toBeGreaterThan(0);
    expect(screen.getAllByText('UP won + house fee').length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole('button', { name: 'Claim 0.02 USDC' })[0]);
    expect(screen.getAllByRole('button', { name: /^Confirm · / }).map((b) => b.textContent)).toContain('Confirm · 0.02 USDC');
  });
});

describe('adversary r2: all-or-nothing with 4 calls per round (spec 6)', () => {
  it('a refused creatorFeeClaimed is retried; a host never sees a ready total without the fee read', async () => {
    rounds = [rawRound({ creator: CHECKSUMMED })];
    let first = true;
    refuse = (fn) => {
      if (fn === 'creatorFeeClaimed' && first) { first = false; return true; }
      return false;
    };
    const t = track();
    const READY = `ready inPlay=${4n * USDC} won=2950000 roundClaims=1:2970000`;
    await waitFor(() => expect(summarise(t.current().chain)).toBe(READY));
    expect(first).toBe(false);
    expect(t.seen.filter((s) => s !== 'loading' && s !== READY)).toEqual([]);
    const perRound = ['roundOf', 'stakeOf', 'stakeClaimed', 'creatorFeeClaimed'].map((f) => calls.filter((c) => c === f).length);
    expect(new Set(perRound).size).toBe(1);
  });
});

describe('adversary r2: counting after a fee was claimed', () => {
  it('a host whose only claim (its fee) is done sees "Everything claimed", not "Nothing to claim yet"', async () => {
    rounds = [rawRound({ creator: CHECKSUMMED })];
    roundStakes = { [`1:${A}`]: { side: 2, amount: 1n * USDC, claimed: false } };
    creatorFeeClaimed = { '1': true };
    const Wrapper = makeWrapper();
    render(<Wrapper><MeClient /></Wrapper>);
    await waitFor(() => expect(screen.getAllByText(/Everything claimed|Nothing to claim yet/).length).toBeGreaterThan(0), { timeout: 4000 });
    expect(screen.queryByText('Nothing to claim yet')).toBeNull();
  });
});

