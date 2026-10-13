// Me's rounds at scale (Codex ME_ROUNDS R1, MAJOR): with hundreds of historical rounds the reads per poll stay bounded
// by 4 x (discovered + ME_ROUNDS_RECENT), whatever roundCount is, and an OLD unclaimed win and an OLD fee-only host
// claim are still found with the exact amounts MakoRoundsV1.claim pays. End to end: the real Me hooks (wagmi +
// TanStack) over a scripted chain (the adversary-me-rounds harness), the real GET /api/me/rounds route over a scripted
// Envio endpoint (helpers/fake-envio.ts). Also: indexer lag never hides a round, and a failed discovery shows the
// rounds part as unavailable, never pools-only totals. And (Codex ME_ROUNDS R2) an indexer serving ANOTHER Rounds
// contract, even one only a round ahead or at the same count, is never trusted: its head round's fingerprint must match
// roundOf on chain, and any head ahead of the chain is unavailable.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import * as React from 'react';
import { createConfig, custom, WagmiProvider } from 'wagmi';
import { decodeFunctionData, encodeFunctionResult, erc20Abi, getAddress, multicall3Abi, type Hex } from 'viem';

import { makoAbi } from '@/lib/MakoMarkets.abi';
import { MAKO_ADDRESS, MarketType, Outcome } from '@/lib/contract';
import { monadTestnet } from '@/lib/chain';
import { ME_ROUNDS_MAX_UNINDEXED, ME_ROUNDS_RECENT } from '@/lib/me-rounds-discovery';
import { roundsAbi } from '@/lib/rounds-abi';

import { answerEnvio, fakeEnvio, type FakeEnvio } from './helpers/fake-envio';

const ROUNDS = '0x00000000000000000000000000000000000000f0' as const;
const A = '0xe490ab83c7f247bec7d5e04ce04bc48d6609b550' as const;
const CHECKSUMMED = getAddress(A);
const HOUSE = '0x00000000000000000000000000000000000000c2' as const;
const EOA = '0x00000000000000000000000000000000000000e0' as const;
const ENVIO = 'https://indexer.test/v1/graphql';

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

const { MeClient } = await import('@/app/me/MeClient');
const { useMeData } = await import('@/app/me/use-me-data');
/// The route, imported fresh for each test so its 15 s per-account cache never carries one test's indexer into the next.
let discoveryRoute: (req: Request) => Promise<Response>;

const USDC = 1_000_000n;
const NOW = Math.floor(Date.now() / 1000);
const MC3 = getAddress(monadTestnet.contracts.multicall3.address);

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
    creator: HOUSE as `0x${string}`,
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
/// An open round, entries still coming.
const openRound = (over: Record<string, unknown> = {}) =>
  rawRound({ status: 1, outcome: 0, startTime: BigInt(NOW + 3000), protocolFee: 0n, creatorFee: 0n, distributable: 0n, ...over });

let rounds: ReturnType<typeof rawRound>[] = [];
/// side 1 = up, 2 = down, as MakoRoundsV1's Side enum.
let roundStakes: Record<string, { side: number; amount: bigint; claimed: boolean }> = {};
let creatorFeeClaimed: Record<string, boolean> = {};
/// Every per-round read the chain answered: `${functionName}:${roundId}`.
const roundCalls: string[] = [];
let env: FakeEnvio;
let discoveryHits = 0;
let discoveryDown = false;

function answerMako(data: Hex): Hex {
  const { functionName, args = [] } = decodeFunctionData({ abi: makoAbi, data });
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
  const id = Number((args[0] as bigint | undefined) ?? 0n);
  if (functionName === 'roundCount') return encodeFunctionResult({ abi: roundsAbi, functionName, result: BigInt(rounds.length) });
  roundCalls.push(`${functionName}:${id}`);
  if (id < 1 || id > rounds.length) throw new Error(`no round ${id}`);
  if (functionName === 'roundOf') return encodeFunctionResult({ abi: roundsAbi, functionName, result: rounds[id - 1] as never });
  const s = roundStakes[`${id}:${String(args[1]).toLowerCase()}`] ?? { side: 0, amount: 0n, claimed: false };
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
    const out = inner.map((c) => ({ success: true, returnData: answer(c.target, c.callData) }));
    return encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: out });
  }
  return answer(to, data);
}

/// The browser's fetch: /api/me/rounds goes to the real route handler, whose own fetch reaches the scripted indexer.
async function browserFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url === ENVIO) return answerEnvio(env, String(init?.body ?? ''));
  if (url.startsWith('/api/me/rounds?')) {
    discoveryHits++;
    if (discoveryDown) return new Response('{"error":"indexer_unavailable"}', { status: 502 });
    return discoveryRoute(new Request(`http://localhost${url}`));
  }
  throw new Error(`unscripted fetch ${url}`);
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
  const box: { latest: ReturnType<typeof useMeData> | null } = { latest: null };
  function Probe() {
    const r = useMeData(A, NOW);
    // eslint-disable-next-line react-hooks/immutability -- test probe: exposes the hook's latest value to the test
    box.latest = r;
    seen.push(summarise(r.chain));
    return null;
  }
  render(<Wrapper><Probe /></Wrapper>);
  return { current: () => box.latest!, seen };
}

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

/// `n` historical rounds; the indexer has all of them. The account entered round 3 (UP, won, unclaimed), hosted round 7
/// (fee unclaimed, no stake), and holds 1.00 USDC in the newest round, still open.
function history(n: number) {
  rounds = Array.from({ length: n }, (_, i) => (i + 1 === n ? openRound() : rawRound({ creator: i + 1 === 7 ? CHECKSUMMED : HOUSE })));
  roundStakes = { [`3:${A}`]: { side: 1, amount: 2n * USDC, claimed: false }, [`${n}:${A}`]: { side: 2, amount: 1n * USDC, claimed: false } };
  creatorFeeClaimed = {};
  env.globalRounds = n;
  env.rounds = rounds.map((r, i) => ({
    id: String(i + 1),
    creator: r.creator.toLowerCase(),
    status: r.status === 2 ? 'Up' : 'Active',
    openTime: String(r.openTime),
    startTime: String(r.startTime),
  }));
  env.entries = [
    { id: `1000_0`, round_id: '3', wallet_id: A },
    { id: `9000_0`, round_id: String(n), wallet_id: A },
    { id: `1001_0`, round_id: '3', wallet_id: HOUSE },
  ];
}

beforeEach(async () => {
  vi.resetModules();
  ({ GET: discoveryRoute } = await import('@/app/api/me/rounds/route'));
  env = fakeEnvio();
  process.env.ENVIO_ROUNDS_GRAPHQL_URL = ENVIO;
  rounds = [];
  roundStakes = {};
  creatorFeeClaimed = {};
  roundCalls.length = 0;
  discoveryHits = 0;
  discoveryDown = false;
  onlineManager.setOnline(true);
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
  vi.spyOn(globalThis, 'fetch').mockImplementation(browserFetch as typeof fetch);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete process.env.ENVIO_ROUNDS_GRAPHQL_URL;
});

const PER_ROUND = ['roundOf', 'stakeOf', 'stakeClaimed', 'creatorFeeClaimed'];
const idsRead = () => [...new Set(roundCalls.map((c) => Number(c.split(':')[1])))].sort((x, y) => x - y);
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe('scale: bounded reads, old claims still found', () => {
  it.each([400, 4000])('%i rounds: an old unclaimed win (#3) and an old fee-only host claim (#7), exact amounts, 4 x (discovered + K) reads a poll', async (n) => {
    history(n);
    expect(contractPays(3, A)).toBe(2_950_000n);
    expect(contractPays(7, A)).toBe(20_000n);
    const t = track();
    const READY = `ready inPlay=${4n * USDC + 1n * USDC} won=2950000 roundClaims=7:20000,3:2950000`;
    await waitFor(() => expect(summarise(t.current().chain)).toBe(READY), { timeout: 4000 });
    expect(t.seen.filter((s) => s !== 'loading' && s !== READY)).toEqual([]);

    // Discovered: 3 (entered), 7 (created), n (Active and entered) -> 3 ids; plus the newest K, which holds the indexer
    // head n (its fingerprint is checked against this roundOf).
    const discovered = 3;
    const expected = [3, 7, ...range(n - ME_ROUNDS_RECENT + 1, n)];
    expect(idsRead()).toEqual(expected);

    // One more poll, counted on its own.
    roundCalls.length = 0;
    await act(async () => { t.current().refetch(); });
    await waitFor(() => expect(roundCalls.length).toBe(expected.length * 4));
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
    expect(roundCalls.length).toBe(expected.length * 4);
    expect(roundCalls.length).toBeLessThanOrEqual(4 * (discovered + ME_ROUNDS_RECENT + 1));
    expect(roundCalls).toContain(`roundOf:${n}`);
    expect(idsRead()).toEqual(expected);
    for (const f of PER_ROUND) expect(roundCalls.filter((c) => c.startsWith(`${f}:`)).length).toBe(expected.length);
    expect(summarise(t.current().chain)).toBe(READY);
  });

  it('the claim buttons on the page carry the contract amounts for both old rounds', async () => {
    history(400);
    const Wrapper = makeWrapper();
    render(<Wrapper><MeClient /></Wrapper>);
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Claim / }).length).toBeGreaterThan(0), { timeout: 4000 });
    const buttons = screen.getAllByRole('button', { name: /^Claim / }).map((b) => b.textContent);
    expect(buttons).toContain('Claim 2.95 USDC');
    expect(buttons).toContain('Claim 0.02 USDC');
    expect(screen.getAllByText('House fee · round you hosted').length).toBeGreaterThan(0);
  });
});

describe('indexer lag never hides a round', () => {
  it('rounds the indexer has not seen, and an old round it still has as Active, are read on chain', async () => {
    history(400);
    // The indexer stopped at round 380: it has round 5 as Active (its settlement not processed), and neither the
    // account's entry in round 5 nor in 390 (both on chain).
    env.globalRounds = 380;
    env.rounds = env.rounds.filter((r) => Number(r.id) <= 380).map((r) => (r.id === '5' ? { ...r, status: 'Active' as const } : r));
    env.entries = env.entries.filter((e) => Number(e.round_id) <= 380);
    roundStakes[`5:${A}`] = { side: 1, amount: 2n * USDC, claimed: false };
    roundStakes[`390:${A}`] = { side: 2, amount: 3n * USDC, claimed: false };
    rounds[389] = rawRound({ status: 3, outcome: 0, refundReason: 1, creatorFee: 0n });
    expect(contractPays(5, A)).toBe(2_950_000n);
    expect(contractPays(390, A)).toBe(3n * USDC);

    const t = track();
    await waitFor(() => expect(summarise(t.current().chain)).toMatch(/^ready/), { timeout: 4000 });
    expect(summarise(t.current().chain)).toBe(`ready inPlay=${5n * USDC} won=5900000 roundClaims=390:3000000,7:20000,5:2950000,3:2950000`);
    // 3 entered, 5 Active in the indexer, 7 created; 380 the indexer's head (fingerprint); 381..400 past the indexer.
    expect(idsRead()).toEqual([3, 5, 7, 380, ...range(381, 400)]);
    // Within the bound: discovered (3, 5, 7) + max(K, unindexed 20) + the head.
    expect(idsRead().length).toBeLessThanOrEqual(3 + Math.max(ME_ROUNDS_RECENT, 20) + 1);
  });

  it('more than ME_ROUNDS_MAX_UNINDEXED rounds past the indexer: unavailable, never a partial list', async () => {
    history(400);
    env.globalRounds = 400 - ME_ROUNDS_MAX_UNINDEXED - 1;
    const t = track();
    await waitFor(() => expect(t.current().chain.status).toBe('error'), { timeout: 4000 });
    expect(t.seen.some((s) => s.startsWith('ready'))).toBe(false);
    expect(roundCalls).toEqual([]);
  });
});

describe('an indexer for ANOTHER Rounds contract is never trusted (Codex ME_ROUNDS R2)', () => {
  /// The chain has 100 rounds; the account's unclaimed 2.95-USDC win is in #3 and its fee-only host claim in #7. The
  /// indexer at ENVIO_ROUNDS_GRAPHQL_URL serves a different MakoRoundsV1 deployment: it has no entry for this account in #3,
  /// and did not see #7 as this account's.
  function foreignIndexer(head: number, fingerprint: { openTime?: bigint; startTime?: bigint; creator?: string } = {}) {
    history(100);
    expect(contractPays(3, A)).toBe(2_950_000n);
    expect(contractPays(7, A)).toBe(20_000n);
    env.globalRounds = head;
    env.rounds = Array.from({ length: head }, (_, i) => {
      const chain = rounds[i];
      return {
        id: String(i + 1),
        creator: HOUSE,
        status: 'Up' as const,
        openTime: String(chain?.openTime ?? BigInt(NOW - 100)),
        startTime: String(chain?.startTime ?? BigInt(NOW + 800)),
      };
    });
    const top = env.rounds[head - 1];
    if (fingerprint.openTime !== undefined) top.openTime = String(fingerprint.openTime);
    if (fingerprint.startTime !== undefined) top.startTime = String(fingerprint.startTime);
    if (fingerprint.creator !== undefined) top.creator = fingerprint.creator;
    env.entries = [];
  }

  it.each([101, 105, 112])('chain count 100, foreign head %i (ahead by 1 to 12): unavailable, never ready, no round read', async (head) => {
    foreignIndexer(head);
    const t = track();
    await waitFor(() => expect(t.current().chain.status).toBe('error'), { timeout: 4000 });
    await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
    expect(t.seen.some((s) => s.startsWith('ready'))).toBe(false);
    expect(t.current().chain.status).toBe('error');
    expect(roundCalls).toEqual([]);
  });

  it.each([
    ['only in openTime', { openTime: BigInt(NOW - 19_999) }],
    ['only in startTime', { startTime: BigInt(NOW + 3900) }],
    ['only in creator', { creator: '0x00000000000000000000000000000000000000c3' }],
  ])('same count (100), foreign head fingerprint differing %s: unavailable, never ready', async (_name, fingerprint) => {
    foreignIndexer(100, fingerprint);
    const t = track();
    await waitFor(() => expect(roundCalls).toContain('roundOf:100'), { timeout: 4000 });
    await waitFor(() => expect(t.current().chain.status).toBe('error'), { timeout: 4000 });
    await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
    expect(t.seen.some((s) => s.startsWith('ready'))).toBe(false);
    expect(t.current().chain.status).toBe('error');
  });

  it('the page reads Unavailable for the foreign same-count indexer, never pools-only totals', async () => {
    foreignIndexer(100, { openTime: BigInt(NOW - 19_999) });
    const Wrapper = makeWrapper();
    render(<Wrapper><MeClient /></Wrapper>);
    await waitFor(() => expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0), { timeout: 4000 });
    expect(screen.queryByText('4.00')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Claim 2.95/ })).toBeNull();
  });

  it('matching fingerprint at count 100: ready, #3 win and #7 host fee found with the contract amounts', async () => {
    history(100);
    const t = track();
    const READY = `ready inPlay=${5n * USDC} won=2950000 roundClaims=7:20000,3:2950000`;
    await waitFor(() => expect(summarise(t.current().chain)).toBe(READY), { timeout: 4000 });
    expect(t.seen.filter((s) => s !== 'loading' && s !== READY)).toEqual([]);
    expect(roundCalls).toContain('roundOf:100');
    expect(contractPays(3, A)).toBe(2_950_000n);
    expect(contractPays(7, A)).toBe(20_000n);
  });

  it('matching fingerprint with the indexer behind: its head round is read too, and the answer is ready', async () => {
    history(100);
    env.globalRounds = 80;
    env.rounds = env.rounds.filter((r) => Number(r.id) <= 80);
    env.entries = env.entries.filter((e) => Number(e.round_id) <= 80);
    const t = track();
    await waitFor(() => expect(summarise(t.current().chain)).toBe(`ready inPlay=${5n * USDC} won=2950000 roundClaims=7:20000,3:2950000`), { timeout: 4000 });
    expect(idsRead()).toEqual([3, 7, 80, ...range(81, 100)]);
  });

  it('a complete read, then the endpoint is switched to a foreign indexer: unavailable, the old totals are not kept', async () => {
    history(100);
    const t = track();
    await waitFor(() => expect(summarise(t.current().chain)).toMatch(/^ready/), { timeout: 4000 });
    vi.resetModules();
    ({ GET: discoveryRoute } = await import('@/app/api/me/rounds/route'));
    env.rounds[99] = { ...env.rounds[99], openTime: String(BigInt(NOW - 19_999)) };
    env.entries = [];
    await act(async () => { t.current().refetch(); });
    await waitFor(() => expect(t.current().chain.status).toBe('error'), { timeout: 4000 });
  });
});

describe('a failed discovery: rounds unavailable, never pools-only totals', () => {
  it('route answers 502 every time: Me is in error, the totals read Unavailable', async () => {
    history(400);
    discoveryDown = true;
    const t = track();
    await waitFor(() => expect(t.current().chain.status).toBe('error'), { timeout: 4000 });
    expect(t.seen.some((s) => s.startsWith('ready'))).toBe(false);
    expect(roundCalls).toEqual([]);
    cleanup();

    const Wrapper = makeWrapper();
    render(<Wrapper><MeClient /></Wrapper>);
    await waitFor(() => expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0), { timeout: 4000 });
    expect(screen.queryByText('4.00')).toBeNull();
  });

  it('indexer not configured (503 from the route): error, not an empty list', async () => {
    history(400);
    delete process.env.ENVIO_ROUNDS_GRAPHQL_URL;
    const t = track();
    await waitFor(() => expect(t.current().chain.status).toBe('error'), { timeout: 4000 });
    expect(t.seen.some((s) => s.startsWith('ready'))).toBe(false);
  });

  it('a discovery refetch that fails after a complete read keeps the last totals', async () => {
    history(400);
    const t = track();
    const READY = `ready inPlay=${5n * USDC} won=2950000 roundClaims=7:20000,3:2950000`;
    await waitFor(() => expect(summarise(t.current().chain)).toBe(READY), { timeout: 4000 });
    discoveryDown = true;
    const before = discoveryHits;
    await act(async () => { t.current().refetch(); await new Promise((r) => setTimeout(r, 400)); });
    expect(discoveryHits).toBeGreaterThan(before);
    expect(summarise(t.current().chain)).toBe(READY);
  });
});
