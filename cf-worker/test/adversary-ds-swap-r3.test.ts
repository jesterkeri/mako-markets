// Adversary round 3 on feat/ds-swap 98771cd: the rotating Data Streams slots (dsTurns) restart their stride whenever
// the eligible count n changes. When pools settle and leave, the slot sequence realigns onto the pools that never
// settle, and a waiting pool goes unevaluated for twice the promised ceil(n / 2) minutes, with a run every minute.
//
// Every HTTP request of the tick is served by a stub installed as the global fetch: nothing leaves the machine and
// nothing is broadcast (DRY_RUN=1). Stub provenance is that of test/adversary-ds-swap.test.ts and
// test/adversary-ds-swap-r2.test.ts: nextMarketId = 119 as read from Mako V4 0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195
// on Monad testnet (2026-10-12), the real BTC/USD report in test/fixtures (close second 1789529160), and Chainlink's
// documented 5 s HMAC clock rule. A Data Streams request for any other second gets 404, the API's answer for a second
// it has no report for.
//
// The chain is modelled as the live path would leave it: a pool the run settles (the DRY RUN line naming its Data
// Streams price) reads back as resolved from the next run on, as it would after its resolveMarket landed.
//
// Six eligible two-sided CRYPTO pools wait at the first run (n = 6, so spec 1 promises 3 consecutive minutes):
//   113, 114, 115: well-formed refs closing at seconds Data Streams has no report for: `wait`, every run;
//   116, 117:      BTC pools closing at the fixture's second: settle on their first evaluation;
//   118:           BTC:gt:75000 closing at the fixture's second: the pool under test.
// Minute indexes (start = 2m mod n): m = 18 (n 6): {113,114}; 19 (n 6): {115,116}, 116 leaves; 20 (n 5): {113,114};
// 21 (n 5): {115,117}, 117 leaves; 22 (n 4): {113,114}; 23 (n 4): {115,118}. Pool 118 waits 6 minutes.
import { decodeAbiParameters, decodeFunctionData, encodeFunctionResult, stringToHex, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import fixture from './fixtures/fixture-btcusd-1789529160.json';
import { makoAbi } from '../src/abi';
import { runResolver, type Env } from '../src/index';

const CLOSE = Number(fixture.observationsTimestamp);
const MARKET_COUNT = 119n;
const MAKO = '0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195';
const MAKO_RPC = 'http://mako-rpc.stub/';
const DS_SKEW_LIMIT_MS = 5_000;
// Minute index 29,833,338: congruent to 18 mod 60, the start the comment above walks through.
const RUN_BASE_MS = 1_790_000_100_000 + 3 * 60_000;

const payload = decodeAbiParameters(
  [{ type: 'bytes32[3]' }, { type: 'bytes' }, { type: 'bytes32[]' }, { type: 'bytes32[]' }, { type: 'bytes32' }],
  fixture.fullReport as Hex,
)[1].toLowerCase() as Hex;
const verifierAbi = [
  { type: 'function', name: 'verify', stateMutability: 'payable', inputs: [{ name: 'payload', type: 'bytes' }, { name: 'parameterPayload', type: 'bytes' }], outputs: [{ name: '', type: 'bytes' }] },
] as const;
const verifyReturn = encodeFunctionResult({ abi: verifierAbi, functionName: 'verify', result: payload }).toLowerCase() as Hex;
const ZERO_WORD = `0x${'0'.repeat(64)}`;

const key = generatePrivateKey();
const resolverAddr = privateKeyToAccount(key).address;

type Pool = { ref: string; close: number };
let pools = new Map<bigint, Pool>();

function market(id: bigint) {
  const p = pools.get(id);
  return {
    creator: resolverAddr,
    mType: 1,
    oracleRef: stringToHex(p?.ref ?? 'BTC:gt:75000', { size: 32 }),
    question: 'crypto pool',
    createdAt: BigInt((p?.close ?? CLOSE) - 86_400),
    closeTime: BigInt(p?.close ?? CLOSE),
    bettingCloseTime: BigInt((p?.close ?? CLOSE) - 60),
    totalYes: 10n ** 18n,
    totalNo: 10n ** 18n,
    yesBettorCount: 1,
    noBettorCount: 1,
    outcome: p ? 0 : 1,
    resolved: !p,
    creatorFeeClaimed: false,
    protocolFeeBpsSnapshot: 0,
    creatorFeeBpsSnapshot: 0,
  };
}

function makoAnswer(m: { id: number; method: string; params?: unknown[] }) {
  if (m.method === 'eth_chainId') return { jsonrpc: '2.0', id: m.id, result: '0x279f' };
  if (m.method !== 'eth_call') return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `stub: ${m.method}` } };
  const call = (m.params![0] as { data: Hex }).data;
  const d = decodeFunctionData({ abi: makoAbi, data: call });
  const result =
    d.functionName === 'owner' || d.functionName === 'resolver'
      ? encodeFunctionResult({ abi: makoAbi, functionName: d.functionName, result: resolverAddr })
      : d.functionName === 'nextMarketId'
        ? encodeFunctionResult({ abi: makoAbi, functionName: 'nextMarketId', result: MARKET_COUNT })
        : encodeFunctionResult({ abi: makoAbi, functionName: 'getMarket', result: market((d.args as [bigint])[0]) as never });
  return { jsonrpc: '2.0', id: m.id, result };
}

function verifyAnswer(m: { id: number; method: string; params?: unknown[] }) {
  if (m.method === 'eth_getBlockByNumber') {
    return { jsonrpc: '2.0', id: m.id, result: { number: '0x4337013', timestamp: `0x${(Math.floor(Date.now() / 1000) - 1).toString(16)}`, hash: `0x${'ab'.repeat(32)}` } };
  }
  const data = (m.params![0] as { data: string }).data;
  return { jsonrpc: '2.0', id: m.id, result: data.length <= 10 ? ZERO_WORD : verifyReturn };
}

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  if (url.startsWith('https://api.testnet-dataengine.chain.link/')) {
    const h = new Headers(init?.headers);
    if (Math.abs(Date.now() - Number(h.get('X-Authorization-Timestamp'))) > DS_SKEW_LIMIT_MS) return json({ error: 'unauthorized' }, 401);
    const second = Number(new URL(url).searchParams.get('timestamp'));
    if (second !== CLOSE) return json({ error: 'not found' }, 404);
    return json({ report: { feedID: fixture.feedID, observationsTimestamp: CLOSE, fullReport: fixture.fullReport } });
  }
  const body = JSON.parse(String(init?.body));
  if (url === MAKO_RPC) return json(Array.isArray(body) ? body.map(makoAnswer) : makoAnswer(body));
  if (url.startsWith('https://testnet-rpc.monad.xyz') || url.startsWith('https://monad-testnet.g.alchemy.com') || url.startsWith('https://rpc.ankr.com/monad_testnet')) return json(verifyAnswer(body));
  throw new Error(`stub: unexpected request to ${url}`);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/// Runs one tick a minute until `target` settles or `maxRuns` pass. Returns the 1-based run it settled in (or null)
/// and the pools each run settled. A settled pool reads back as resolved from the next run on.
async function runUntilSettled(target: bigint, maxRuns: number): Promise<{ settledInRun: number | null; perRun: number[][] }> {
  vi.stubGlobal('fetch', vi.fn(stubFetch));
  let lines: string[] = [];
  for (const k of ['log', 'warn', 'error'] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
  const env = {
    MAKO_ADDRESS: MAKO,
    MONAD_RPC_URL: MAKO_RPC,
    ADMIN_PRIVATE_KEY: key,
    DRY_RUN: '1',
    CRYPTO_PRICE_SOURCE: 'datastreams',
    DATASTREAMS_API_KEY: 'sentinel-ds-key',
    DATASTREAMS_API_SECRET: 'sentinel-ds-secret',
      ALCHEMY_RPC_URL: 'https://monad-testnet.g.alchemy.com/v2/sentinel-alchemy-key',
  } as Env;
  const perRun: number[][] = [];
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    for (let t = 0; t < maxRuns; t++) {
      lines = [];
      vi.setSystemTime(RUN_BASE_MS + t * 60_000);
      await runResolver(env);
      const settled = lines
        .filter((l) => l.includes('Chainlink Data Streams 75938.791787') && l.includes('DRY RUN'))
        .map((l) => Number(/market (\d+):/.exec(l)![1]));
      perRun.push(settled);
      for (const id of settled) pools.delete(BigInt(id));
      if (settled.includes(Number(target))) return { settledInRun: t + 1, perRun };
    }
  } finally {
    vi.useRealTimers();
  }
  return { settledInRun: null, perRun };
}

describe('adversary r3: the rotation stride resets when the eligible count shrinks', () => {
  // Found by r3: the rotation phase restarts when n shrinks (here 6 minutes, not ceil(6/2) = 3). Accepted for the swap
  // (a stopgap). This is a DRY-RUN case: it measures the Data Streams rotation only. Live settlement time is NOT bounded
  // by it: production's one-send-per-tick rule applies first (Codex DS_SWAP R1, disclosed in dsTurns' doc).
  it('no starvation: with n = 6 eligible pools waiting and some settling, pool 118 settles within 2n = 12 minutes', async () => {
    pools = new Map([
      [113n, { ref: 'ETH:gt:2500', close: CLOSE - 180 }],
      [114n, { ref: 'SOL:lt:150', close: CLOSE - 120 }],
      [115n, { ref: 'ETH:gt:2500', close: CLOSE - 60 }],
      [116n, { ref: 'BTC:lt:80000', close: CLOSE }],
      [117n, { ref: 'BTC:gt:70000', close: CLOSE }],
      [118n, { ref: 'BTC:gt:75000', close: CLOSE }],
    ]);
    const r = await runUntilSettled(118n, 12);
    expect(r.settledInRun).not.toBeNull();
    expect(r.settledInRun!).toBeLessThanOrEqual(12);
    expect(r.settledInRun).toBe(6); // the observed worst case for this scenario, pinned so a regression shows
  }, 300_000);
});
