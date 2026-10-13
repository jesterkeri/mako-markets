// Adversary pass on 71d7a07 (Codex ME_ROUNDS R2 fix): the indexer's head round fingerprint binds the Me rounds
// discovery to this Rounds contract. Spec points, from the brief: (1) never `ready` from an indexer that does not
// index this contract or cannot be bound; (2) with the right indexer every claim is found, reads bounded by
// 4 x (discovered + max(12, unindexed) + 1); (3) the head check uses the same tick's on-chain read, never skipped or
// satisfied by stale data; (4) any malformed head is unavailable. Pure checks on parse/plan, the real route over a
// scripted Envio, and the real useMeRounds hook (wagmi + TanStack) over a scripted chain.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import * as React from 'react';
import { createConfig, custom, WagmiProvider } from 'wagmi';
import { decodeFunctionData, encodeFunctionResult, getAddress, multicall3Abi, type Hex } from 'viem';

import { monadTestnet } from '@/lib/chain';
import {
  headMatchesChain,
  ME_ROUNDS_RECENT,
  parseMeRoundsDiscovery,
  planMeRoundReads,
  type MeRoundsDiscovery,
} from '@/lib/me-rounds-discovery';
import { roundsAbi } from '@/lib/rounds-abi';

import { answerEnvio, fakeEnvio, type FakeEnvio } from './helpers/fake-envio';

const ROUNDS = '0x00000000000000000000000000000000000000f0' as const;
const A = '0xe490ab83c7f247bec7d5e04ce04bc48d6609b550' as const;
const HOUSE = '0x00000000000000000000000000000000000000c2' as const;
const ENVIO = 'https://indexer.test/v1/graphql';
const CREATOR = '0x00000000000000000000000000000000000000c2';

vi.mock('@/lib/contract', async (orig) => ({ ...(await orig<typeof import('@/lib/contract')>()), ROUNDS_ADDRESS: '0x00000000000000000000000000000000000000f0' }));

const { useMeRounds } = await import('@/lib/use-me-rounds');

// ---------------------------------------------------------------------------------------------------------------
// Pure: parse, plan, headMatchesChain
// ---------------------------------------------------------------------------------------------------------------

const head = (over: Record<string, unknown> = {}) => ({ id: '100', openTime: '1760000000', startTime: '1760000900', creator: CREATOR, ...over });
const wire = (over: Record<string, unknown> = {}) => ({ roundIds: ['3'], indexedThrough: '100', head: head(), ...over });

describe('spec 4: a malformed head is never trusted', () => {
  it.each([
    ['head null with indexedThrough > 0', wire({ head: null })],
    ['head present with indexedThrough 0', wire({ indexedThrough: '0', head: head({ id: '0' }) })],
    ['head missing entirely with indexedThrough 0', { roundIds: [], indexedThrough: '0' }],
    ['head id for a different round', wire({ head: head({ id: '99' }) })],
    ['head id as a number', wire({ head: head({ id: 100 }) })],
    ['head id with a leading zero', wire({ head: head({ id: '0100' }) })],
    ['openTime as a number', wire({ head: head({ openTime: 1760000000 }) })],
    ['startTime as a BigInt-looking string', wire({ head: head({ startTime: '1760000900n' }) })],
    ['openTime missing', wire({ head: head({ openTime: undefined }) })],
    ['creator missing', wire({ head: head({ creator: undefined }) })],
    ['creator upper case', wire({ head: head({ creator: CREATOR.toUpperCase().replace('0X', '0x') }) })],
    ['creator checksummed', wire({ head: head({ creator: getAddress(A) }) })],
    ['creator short', wire({ head: head({ creator: '0xc2' }) })],
    ['openTime = 2^64 (uint64 overflow)', wire({ head: head({ openTime: (1n << 64n).toString() }) })],
    ['startTime 21 digits', wire({ head: head({ startTime: '1'.repeat(21) }) })],
    ['openTime negative', wire({ head: head({ openTime: '-1' }) })],
    ['head an array', wire({ head: ['100', '1760000000', '1760000900', CREATOR] })],
    ['head a string', wire({ head: '100' })],
  ])('%s: parse refuses', (_name, body) => {
    expect(parseMeRoundsDiscovery(body)).toBeNull();
  });

  it('uint64 max is accepted (boundary)', () => {
    const max = ((1n << 64n) - 1n).toString();
    expect(parseMeRoundsDiscovery(wire({ head: head({ openTime: max }) }))?.head?.openTime).toBe((1n << 64n) - 1n);
  });
});

describe('spec 1: the fingerprint compares exactly', () => {
  const h = parseMeRoundsDiscovery(wire())!.head!;
  const chain = { creator: getAddress(CREATOR) as string, openTime: 1760000000n, startTime: 1760000900n };
  it('same id, creator, startTime; openTime one second either side: not bound', () => {
    expect(headMatchesChain(h, chain)).toBe(true);
    expect(headMatchesChain(h, { ...chain, openTime: 1759999999n })).toBe(false);
    expect(headMatchesChain(h, { ...chain, openTime: 1760000001n })).toBe(false);
    expect(headMatchesChain(h, { ...chain, startTime: 1760000901n })).toBe(false);
    expect(headMatchesChain(h, { ...chain, creator: '0x00000000000000000000000000000000000000c3' })).toBe(false);
  });
});

describe('spec 2/3: the head round is always in the read set, and reads stay bounded', () => {
  it('for every count, indexedThrough <= count, and any discovered set, head.id is read and the bound holds', () => {
    const counts = [1, 2, 11, 12, 13, 50, 131, 132, 133, 400];
    for (const count of counts) {
      for (let through = 1; through <= count; through++) {
        if (count - through > 120) continue;
        const discovered = [1, 2, 3, through - 1, through, through + 1, count, count + 5].filter((x) => x >= 1);
        const d: MeRoundsDiscovery = {
          roundIds: [...new Set(discovered)].sort((x, y) => x - y).map(BigInt),
          indexedThrough: BigInt(through),
          head: { id: BigInt(through), openTime: 1n, startTime: 2n, creator: CREATOR },
        };
        const plan = planMeRoundReads(BigInt(count), d);
        expect(plan.ok).toBe(true);
        if (!plan.ok) continue;
        expect(plan.ids).toContain(BigInt(through));
        expect(new Set(plan.ids.map(String)).size).toBe(plan.ids.length);
        expect(plan.ids.every((x) => x >= 1n && x <= BigInt(count))).toBe(true);
        const unindexed = count - through;
        expect(plan.ids.length).toBeLessThanOrEqual(d.roundIds.length + Math.max(ME_ROUNDS_RECENT, unindexed) + 1);
      }
    }
  });

  it('any head above count is refused, at every distance', () => {
    for (const ahead of [1, 2, 12, 13, 1000]) {
      const d: MeRoundsDiscovery = { roundIds: [], indexedThrough: BigInt(100 + ahead), head: { id: BigInt(100 + ahead), openTime: 1n, startTime: 2n, creator: CREATOR } };
      expect(planMeRoundReads(100n, d)).toEqual({ ok: false, reason: 'indexer_ahead' });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Route: Hasura shapes
// ---------------------------------------------------------------------------------------------------------------

describe('route: the head row as Hasura may answer it', () => {
  let env: FakeEnvio;
  let GET: (req: Request) => Promise<Response>;
  beforeEach(async () => {
    vi.resetModules();
    env = fakeEnvio();
    process.env.ENVIO_ROUNDS_GRAPHQL_URL = ENVIO;
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (i: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof i === 'string' ? i : i instanceof URL ? i.href : i.url;
      if (url !== ENVIO) throw new Error(`unscripted ${url}`);
      return answerEnvio(env, String(init?.body ?? ''));
    }) as typeof fetch);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    ({ GET } = await import('@/app/api/me/rounds/route'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ENVIO_ROUNDS_GRAPHQL_URL;
  });
  const get = () => GET(new Request(`http://localhost/api/me/rounds?account=${A}`));

  it('a small JSON number for openTime is answered as the canonical decimal string the browser accepts', async () => {
    env.globalRounds = 2;
    env.rounds = [{ id: '1', creator: CREATOR, status: 'Up' }, { id: '2', creator: CREATOR, status: 'Up', openTime: 1760000000, startTime: '1760000900' }];
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.head).toEqual({ id: '2', openTime: '1760000000', startTime: '1760000900', creator: CREATOR });
    expect(parseMeRoundsDiscovery(body)).not.toBeNull();
  });

  it.each([
    ['openTime a JSON number above 2^53', { openTime: 2 ** 53 + 2 }],
    ['openTime a fraction', { openTime: 1760000000.5 }],
    ['startTime above uint64', { startTime: (1n << 64n).toString() }],
    ['creator checksummed', { creator: getAddress(A) }],
  ])('%s: 502, never a head', async (_n, over) => {
    env.globalRounds = 2;
    env.rounds = [{ id: '1', creator: CREATOR, status: 'Up' }, { id: '2', creator: CREATOR, status: 'Up', ...over } as never];
    const res = await get();
    expect(res.status).toBe(502);
  });

  it('the indexer answers a head row for a different id than GlobalStats.rounds: 502', async () => {
    env.globalRounds = 2;
    env.rounds = [{ id: '1', creator: CREATOR, status: 'Up' }, { id: '2', creator: CREATOR, status: 'Up' }];
    env.override = (op) => (op === 'headRound' ? Response.json({ data: { Round: [{ id: '1', openTime: '1', startTime: '2', creator: CREATOR }] } }) : null);
    expect((await get()).status).toBe(502);
  });

  it('two head rows: 502', async () => {
    env.globalRounds = 2;
    env.override = (op) =>
      op === 'headRound'
        ? Response.json({ data: { Round: [{ id: '2', openTime: '1', startTime: '2', creator: CREATOR }, { id: '2', openTime: '1', startTime: '2', creator: CREATOR }] } })
        : null;
    expect((await get()).status).toBe(502);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Hook: the real useMeRounds over a scripted chain and the real route
// ---------------------------------------------------------------------------------------------------------------

const USDC = 1_000_000n;
const NOW = Math.floor(Date.now() / 1000);
const MC3 = getAddress(monadTestnet.contracts.multicall3.address);

function rawRound(i: number, over: Record<string, unknown> = {}) {
  return {
    creator: HOUSE as `0x${string}`,
    openTime: BigInt(NOW - 200_000 + i * 900),
    startTime: BigInt(NOW - 199_000 + i * 900),
    status: 2,
    outcome: 1,
    refundReason: 0,
    anchorPrice: 1n,
    closePrice: 2n,
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
let roundStakes: Record<string, { side: number; amount: bigint; claimed: boolean }> = {};
const roundCalls: string[] = [];
let env: FakeEnvio;
let discoveryRoute: (req: Request) => Promise<Response>;

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
  if (functionName === 'creatorFeeClaimed') return encodeFunctionResult({ abi: roundsAbi, functionName, result: false });
  throw new Error(`unscripted rounds ${functionName}`);
}

async function request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
  if (method === 'eth_chainId') return `0x${monadTestnet.id.toString(16)}`;
  if (method !== 'eth_call') throw new Error(`unscripted ${method}`);
  const [{ to, data }] = params as [{ to: string; data: Hex }];
  if (getAddress(to) === MC3) {
    const { args } = decodeFunctionData({ abi: multicall3Abi, data });
    const inner = args[0] as readonly { target: string; callData: Hex }[];
    return encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: inner.map((c) => ({ success: true, returnData: answerRounds(c.callData) })) });
  }
  if (getAddress(to) !== getAddress(ROUNDS)) throw new Error(`unscripted target ${to}`);
  return answerRounds(data);
}

async function browserFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url === ENVIO) return answerEnvio(env, String(init?.body ?? ''));
  if (url.startsWith('/api/me/rounds?')) return discoveryRoute(new Request(`http://localhost${url}`));
  throw new Error(`unscripted fetch ${url}`);
}

/// The indexer exactly mirrors the chain's first `upTo` rounds (the right indexer), the account's win in #3.
function indexerOf(upTo: number) {
  env.globalRounds = upTo;
  env.rounds = rounds.slice(0, upTo).map((r, i) => ({
    id: String(i + 1),
    creator: r.creator.toLowerCase(),
    status: 'Up' as const,
    openTime: String(r.openTime),
    startTime: String(r.startTime),
  }));
  env.entries = upTo >= 3 ? [{ id: '1000_0', round_id: '3', wallet_id: A }] : [];
}

type Out = ReturnType<typeof useMeRounds>;
const sum = (r: Out) => (r.status === 'ready' ? `ready ${r.rounds.map((x) => String(x.id)).join(',')}` : r.status);

function track() {
  const config = createConfig({ chains: [monadTestnet], transports: { [monadTestnet.id]: custom({ request }, { retryCount: 0 }) }, multiInjectedProviderDiscovery: false, ssr: false });
  const qc = new QueryClient({ defaultOptions: { queries: { retryDelay: 20 } } });
  const seen: string[] = [];
  const box: { latest: Out | null } = { latest: null };
  function Probe() {
    const r = useMeRounds(A);
    // eslint-disable-next-line react-hooks/immutability -- test probe: exposes the hook's latest value to the test
    box.latest = r;
    seen.push(sum(r));
    return null;
  }
  render(
    <WagmiProvider config={config} reconnectOnMount={false}>
      <QueryClientProvider client={qc}><Probe /></QueryClientProvider>
    </WagmiProvider>,
  );
  return { current: () => box.latest!, seen };
}

async function freshRoute() {
  vi.resetModules();
  ({ GET: discoveryRoute } = await import('@/app/api/me/rounds/route'));
}

beforeEach(async () => {
  await freshRoute();
  env = fakeEnvio();
  process.env.ENVIO_ROUNDS_GRAPHQL_URL = ENVIO;
  rounds = Array.from({ length: 100 }, (_, i) => rawRound(i));
  roundStakes = { [`3:${A}`]: { side: 1, amount: 2n * USDC, claimed: false } };
  roundCalls.length = 0;
  onlineManager.setOnline(true);
  vi.spyOn(globalThis, 'fetch').mockImplementation(browserFetch as typeof fetch);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete process.env.ENVIO_ROUNDS_GRAPHQL_URL;
});

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 150)); });

describe('hook: the binding is re-checked on every answer, never carried over', () => {
  it('ready with the right indexer, then the URL starts serving a foreign deployment at the same count (openTime +1 s): error, never ready on the foreign answer', async () => {
    indexerOf(100);
    const t = track();
    await waitFor(() => expect(t.current().status).toBe('ready'), { timeout: 4000 });
    expect(sum(t.current())).toContain('3,');

    // Foreign: same id 100, same creator, same startTime, openTime one second later; no entry for the account.
    env.rounds = env.rounds.map((r) => (r.id === '100' ? { ...r, openTime: String(BigInt(r.openTime as string) + 1n) } : r));
    env.entries = [];
    await freshRoute();
    const before = t.seen.length;
    await act(async () => { t.current().refetch(); });
    await waitFor(() => expect(t.current().status).toBe('error'), { timeout: 4000 });
    await settle();
    const after = t.seen.slice(before);
    // Once the foreign answer is in, no ready state lists the rounds without #3.
    expect(after.filter((s) => s.startsWith('ready') && !s.split(' ')[1].split(',').includes('3'))).toEqual([]);
    expect(t.current().status).toBe('error');
  });

  it('count grows (a new round) at the same time the indexer turns foreign at the new count: error, never ready', async () => {
    indexerOf(100);
    const t = track();
    await waitFor(() => expect(t.current().status).toBe('ready'), { timeout: 4000 });

    rounds.push(rawRound(100));
    indexerOf(101);
    env.rounds = env.rounds.map((r) => (r.id === '101' ? { ...r, creator: '0x00000000000000000000000000000000000000c3' } : r));
    env.entries = [];
    await freshRoute();
    const before = t.seen.length;
    await act(async () => { t.current().refetch(); });
    await waitFor(() => expect(t.current().status).toBe('error'), { timeout: 4000 });
    await settle();
    expect(t.seen.slice(before).some((s) => s.startsWith('ready') && s.includes(',101'))).toBe(false);
    expect(t.current().status).toBe('error');
  });

  it('foreign indexer behind (head 80) whose fingerprint differs: error, and the head round is read on chain', async () => {
    indexerOf(80);
    env.rounds = env.rounds.map((r) => (r.id === '80' ? { ...r, startTime: String(BigInt(r.startTime as string) + 60n) } : r));
    env.entries = [];
    const t = track();
    await waitFor(() => expect(roundCalls).toContain('roundOf:80'), { timeout: 4000 });
    await waitFor(() => expect(t.current().status).toBe('error'), { timeout: 4000 });
    await settle();
    expect(t.seen.some((s) => s.startsWith('ready'))).toBe(false);
  });

  it('indexer with no rounds (head null) over 100 rounds on chain: every round read, #3 found (complete without the indexer)', async () => {
    indexerOf(0);
    const t = track();
    await waitFor(() => expect(t.current().status).toBe('ready'), { timeout: 4000 });
    const ids = (t.current() as Extract<Out, { status: 'ready' }>).rounds.map((r) => Number(r.id));
    expect(ids).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
  });
});
