// Adversary on cffadab (Me page degrades when the Rounds read fails, spec 2026-11-20). Real Me hooks (wagmi +
// TanStack) over the scripted chain and indexer of me-rounds-scale.test.tsx, whose harness is copied here because
// that file registers its own tests. Spec rule 2: the three totals that count rounds (In play, Ready to claim, Won
// all time) read "Unavailable" on desktop AND mobile while rounds have failed; no figure from pools alone.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import * as React from 'react';
import { createConfig, custom, WagmiProvider } from 'wagmi';
import { decodeFunctionData, encodeFunctionResult, erc20Abi, getAddress, multicall3Abi, type Hex } from 'viem';

import { makoAbi } from '@/lib/MakoMarkets.abi';
import { MAKO_ADDRESS, MarketType, Outcome } from '@/lib/contract';
import { monadTestnet } from '@/lib/chain';
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

const { MeClient } = await import('@/app/me/MeClient');
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
let discoveryDown = false;

function answerMako(data: Hex): Hex {
  const { functionName, args = [] } = decodeFunctionData({ abi: makoAbi, data });
  if (functionName === 'nextMarketId') return encodeFunctionResult({ abi: makoAbi, functionName, result: 1n });
  if (functionName === 'getMarket') return encodeFunctionResult({ abi: makoAbi, functionName, result: poolNow as never });
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

let poolNow: typeof pool0 = pool0;
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


// A pool the account won and can claim: that claim is a pools-only figure while the rounds are unknown.
function wonPool() {
  poolNow = { ...pool0, resolved: true, outcome: Outcome.YES, closeTime: BigInt(NOW - 3600), bettingCloseTime: BigInt(NOW - 7200) };
}

async function renderDown() {
  history(400);
  wonPool();
  discoveryDown = true;
  const Wrapper = makeWrapper();
  render(<Wrapper><MeClient /></Wrapper>);
  await waitFor(() => expect(screen.getAllByRole('status').length).toBeGreaterThan(0), { timeout: 4000 });
  return {
    desk: document.querySelector('.mk-desk') as HTMLElement,
    mob: document.querySelector('.mk-mob') as HTMLElement,
  };
}

describe('rounds read failed, pool claim present (real hooks)', () => {
  it('desktop: the Ready to claim figures are Unavailable, never a pools-only count', async () => {
    const { desk } = await renderDown();
    expect(within(desk).getByRole('button', { name: /^Claim / })).toBeTruthy();
    const heading = within(desk).getByText('Ready to claim');
    // The header row of the Ready to claim list carries the count of claims. Pool claims = 1; the rounds claims are
    // unknown, so a bare "1" is a figure that is too low.
    expect(heading.parentElement!.textContent).not.toBe('Ready to claim1');
  });

  it('mobile: Ready to claim reads Unavailable, never a pools-only count', async () => {
    const { mob } = await renderDown();
    expect(within(mob).getByRole('button', { name: /^Claim / })).toBeTruthy();
    const heading = within(mob).getByText('Ready to claim');
    expect(heading.parentElement!.textContent).not.toBe('Ready to claim1');
    // In play, Won all time and Ready to claim: three totals, three Unavailable.
    expect(within(mob).getAllByText('Unavailable').length).toBe(3);
  });
});

describe('transitions (real hooks)', () => {
  it('Try again while still down: the pools never vanish into the loading state and the note stays', async () => {
    const { desk } = await renderDown();
    const seenGone: string[] = [];
    const obs = new MutationObserver(() => {
      if (!screen.queryAllByText('Open pool?').length && !screen.queryAllByRole('button', { name: /^Claim / }).length) seenGone.push('pools gone');
    });
    obs.observe(document.body, { childList: true, subtree: true });
    await act(async () => {
      fireEvent.click(within(desk).getByRole('button', { name: 'Try again' }));
      await new Promise((r) => setTimeout(r, 300));
    });
    obs.disconnect();
    expect(seenGone).toEqual([]);
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
  });

  it('Try again once the indexer is back: rounds totals return, the note goes', async () => {
    const { desk } = await renderDown();
    discoveryDown = false;
    await act(async () => {
      fireEvent.click(within(desk).getByRole('button', { name: 'Try again' }));
    });
    await waitFor(() => expect(screen.queryAllByRole('status')).toHaveLength(0), { timeout: 4000 });
    for (const el of screen.getAllByText('IN PLAY')) expect(el.parentElement!.textContent).not.toContain('Unavailable');
    expect(screen.queryAllByText('Unavailable')).toHaveLength(0);
  });
});
