
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import * as React from 'react';
import { createConfig, custom, WagmiProvider } from 'wagmi';
import { decodeFunctionData, encodeFunctionResult, erc20Abi, getAddress, multicall3Abi, type Hex } from 'viem';

import { makoAbi } from '@/lib/MakoMarkets.abi';
import { MAKO_ADDRESS, MarketType, Outcome } from '@/lib/contract';
import { monadTestnet } from '@/lib/chain';
import { ME_ROUNDS_MAX_UNINDEXED } from '@/lib/me-rounds-discovery';
import { roundsAbi } from '@/lib/rounds-abi';

import { answerEnvio, fakeEnvio, type FakeEnvio } from './helpers/fake-envio';

// The route's caller binding and the shared Envio budget are tested on their own (me-rounds-caller / envio-budget
// tests); here every caller is allowed and every call has budget, so this file tests discovery itself.
vi.mock('@/lib/me-rounds-caller', () => ({ authorizeMeRoundsCaller: async () => ({ ok: true }) }));
vi.mock('@/lib/envio-budget', async (orig) => ({ ...(await orig<typeof import('@/lib/envio-budget')>()), reserveEnvioCall: async () => {} }));

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
/// Every rounds read but roundCount is refused (the round count still answers, so a new round still changes the reads).
let roundReadsDown = false;
/// A refused call fails only its own item in a multicall (success: false), so every item of the read is still recorded.
class Refused extends Error {}

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
  if (roundReadsDown) throw new Refused();
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
    const out = inner.map((c) => {
      try {
        return { success: true, returnData: answer(c.target, c.callData) };
      } catch (e) {
        if (e instanceof Refused) return { success: false, returnData: '0x' as Hex };
        throw e;
      }
    });
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
  roundReadsDown = false;
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


const { useMeRounds } = await import('@/lib/use-me-rounds');
const B = '0x00000000000000000000000000000000000000b2' as const;

type Acct = typeof A | typeof B;
/// What one render of the hook shows: status plus every stake it carries (`roundId=amount`).
function sig(r: ReturnType<typeof useMeRounds>): string {
  if (r.status !== 'ready') return r.status;
  return `ready ${r.rounds.length}r ${[...r.stakes].filter(([, s]) => s.stake.amount > 0n).map(([id, s]) => `${id}=${s.stake.amount}`).join(',')}`;
}
function trackRounds(first: Acct, strict = false) {
  const Wrapper = makeWrapper();
  const seen: { account: Acct; sig: string }[] = [];
  const box: { latest: ReturnType<typeof useMeRounds> | null } = { latest: null };
  function Probe({ account }: { account: Acct }) {
    const r = useMeRounds(account);
    // eslint-disable-next-line react-hooks/immutability -- test probe: exposes the hook's latest value to the test
    box.latest = r;
    seen.push({ account, sig: sig(r) });
    return null;
  }
  const ui = (account: Acct) => {
    const inner = <Wrapper><Probe account={account} /></Wrapper>;
    return strict ? <React.StrictMode>{inner}</React.StrictMode> : inner;
  };
  const view = render(ui(first));
  return { current: () => box.latest!, seen, switchTo: (a: Acct) => view.rerender(ui(a)) };
}
const sigsOf = (t: ReturnType<typeof trackRounds>, a: Acct, from = 0) => t.seen.slice(from).filter((s) => s.account === a).map((s) => s.sig);

const A_READY = `ready 14r ${['3=2000000', `100=1000000`].join(',')}`;

describe('account switch: the kept read belongs to one account', () => {
  it('A ready, then B whose rounds read is refused: B never shows A stakes, not for one render', async () => {
    history(100);
    const t = trackRounds(A);
    await waitFor(() => expect(sig(t.current())).toBe(A_READY), { timeout: 4000 });
    roundStakes[`50:${B}`] = { side: 1, amount: 7n * USDC, claimed: false };
    env.entries.push({ id: '5000_0', round_id: '50', wallet_id: B });
    roundReadsDown = true;
    const from = t.seen.length;
    await act(async () => { t.switchTo(B); });
    // Wait for B's refused read to settle (a fixed sleep flaked under a loaded full run), then check every B render.
    await waitFor(() => expect(sig(t.current())).toBe('error'), { timeout: 4000 });
    expect(sigsOf(t, B, from).filter((s) => s !== 'loading' && s !== 'error')).toEqual([]);
  });

  it('A ready, then B ready, then back to A: each account only ever sees its own stakes', async () => {
    history(100);
    roundStakes[`50:${B}`] = { side: 1, amount: 7n * USDC, claimed: false };
    env.entries.push({ id: '5000_0', round_id: '50', wallet_id: B });
    const t = trackRounds(A);
    await waitFor(() => expect(sig(t.current())).toBe(A_READY), { timeout: 4000 });
    await act(async () => { t.switchTo(B); });
    await waitFor(() => expect(sig(t.current())).toMatch(/50=7000000/), { timeout: 4000 });
    await act(async () => { t.switchTo(A); });
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
    for (const s of sigsOf(t, B)) expect(s).not.toMatch(/3=2000000|100=1000000/);
    for (const s of sigsOf(t, A)) expect(s).not.toMatch(/50=7000000/);
    expect(sig(t.current())).toBe(A_READY);
  });

  it('A kept, B refused, back to A with its reads refused too: A keeps its own read', async () => {
    history(100);
    const t = trackRounds(A);
    await waitFor(() => expect(sig(t.current())).toBe(A_READY), { timeout: 4000 });
    roundReadsDown = true;
    await act(async () => { t.switchTo(B); });
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
    await act(async () => { t.switchTo(A); });
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
    expect(sigsOf(t, B).some((s) => s.startsWith('ready'))).toBe(false);
    expect(sig(t.current())).toBe(A_READY);
  });
});

describe('the kept read under StrictMode and a changing read set', () => {
  it('StrictMode: a new round and refused reads keep the last complete read (no loading, no error)', async () => {
    history(100);
    const t = trackRounds(A, true);
    await waitFor(() => expect(sig(t.current())).toBe(A_READY), { timeout: 4000 });
    const from = t.seen.length;
    rounds.push(openRound());
    roundReadsDown = true;
    await act(async () => { t.current().refetch(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
    expect(new Set(sigsOf(t, A, from))).toEqual(new Set([A_READY]));
  });
});

describe('evidence against the read, racing a loading state', () => {
  it('indexer too far behind after a new round batch: Unavailable at once, never the kept read, and a later refused read stays Unavailable', async () => {
    history(100);
    const t = trackRounds(A);
    await waitFor(() => expect(sig(t.current())).toBe(A_READY), { timeout: 4000 });
    const from = t.seen.length;
    for (let i = 0; i < ME_ROUNDS_MAX_UNINDEXED + 5; i++) rounds.push(openRound());
    await act(async () => { t.current().refetch(); });
    await waitFor(() => expect(sig(t.current())).toBe('error'), { timeout: 4000 });
    expect(sigsOf(t, A, from).filter((s) => s.startsWith('ready'))).toEqual([]);
    roundReadsDown = true;
    env.globalRounds = rounds.length - 10; // the indexer catches up enough to bound the reads; its head is still the old one
    await act(async () => { t.current().refetch(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 500)); });
    expect(sigsOf(t, A, from).filter((s) => s.startsWith('ready'))).toEqual([]);
  });

  it('foreign head whose round the kept read already holds, and the new reads refused: Unavailable, not the kept read', async () => {
    history(100);
    const t = trackRounds(A);
    await waitFor(() => expect(sig(t.current())).toBe(A_READY), { timeout: 4000 });
    const from = t.seen.length;
    // The indexer is swapped for another Rounds contract: same head id 100, different fingerprint. The chain also
    // gets round 101, so the read set changes (new key, no previous data) and its reads are refused.
    vi.resetModules();
    ({ GET: discoveryRoute } = await import('@/app/api/me/rounds/route'));
    env.rounds[99] = { ...env.rounds[99], openTime: String(BigInt(NOW - 19_999)) };
    env.entries = [];
    rounds.push(openRound());
    roundReadsDown = true;
    await act(async () => { t.current().refetch(); });
    // Until the foreign discovery arrives the kept read is correct to show (no evidence yet); once it has, the page is
    // Unavailable and the kept read never comes back. A fixed sleep here was order-sensitive under a loaded run.
    await waitFor(() => expect(sig(t.current())).toBe('error'), { timeout: 4000 });
    const known = t.seen.length;
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
    expect(sigsOf(t, A, known).filter((s) => s.startsWith('ready'))).toEqual([]);
    expect(sig(t.current())).toBe('error');
    expect(t.seen.length).toBeGreaterThan(from);
  });

  it('control: the same swap with the reads ANSWERED is detected and reads Unavailable (so the discovery did arrive)', async () => {
    history(100);
    const t = trackRounds(A);
    await waitFor(() => expect(sig(t.current())).toBe(A_READY), { timeout: 4000 });
    vi.resetModules();
    ({ GET: discoveryRoute } = await import('@/app/api/me/rounds/route'));
    env.rounds[99] = { ...env.rounds[99], openTime: String(BigInt(NOW - 19_999)) };
    env.entries = [];
    rounds.push(openRound());
    const hits = discoveryHits;
    await act(async () => { t.current().refetch(); });
    await waitFor(() => expect(sig(t.current())).toBe('error'), { timeout: 4000 });
    expect(discoveryHits).toBeGreaterThan(hits);
  });
});
