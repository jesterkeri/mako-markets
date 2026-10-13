// Adversary on feat/ds-swap 6875a42 (Alchemy + Ankr pair). Harness copied from test/adversary-ds-swap.test.ts (adversary on 3da84d8): runResolver in CRYPTO_PRICE_SOURCE=datastreams, end to end through its own wiring.
//
// Every HTTP request of the tick is served by a stub installed as the global fetch: nothing leaves the machine and
// nothing is broadcast (DRY_RUN=1).
//
//   * Mako V4 (MONAD_RPC_URL stub): nextMarketId = 119, the value read from 0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195
//     on https://testnet-rpc.monad.xyz on 2026-10-12 (eth_call 0x406ef2ef at block ~0x4337013). Markets 0 to 117 are
//     resolved; market 118 is a two-sided CRYPTO pool `BTC:gt:75000` closing at the second of the real BTC/USD report
//     in test/fixtures (1789529160).
//   * Data Streams API: answers with that real report, and applies the documented clock rule of Chainlink's HMAC auth:
//     "X-Authorization-Timestamp: The current timestamp, with precision up to milliseconds. The timestamp must closely
//     synchronize with the server time, allowing a maximum discrepancy of 5 seconds (by default)."
//     (https://docs.chain.link/data-streams/reference/data-streams-api/interface-api, fetched 2026-10-12). A request
//     whose timestamp is further than that from the time it arrives gets 401.
//   * Verification providers (Monad public RPC + Ankr): s_feeManager() = 0, verify() = the real verified return, as in
//     test/crypto-datastreams.test.ts.
import { decodeAbiParameters, decodeFunctionData, encodeFunctionResult, stringToHex, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import fixture from './fixtures/fixture-btcusd-1789529160.json';
import { makoAbi } from '../src/abi';
import { runResolver, type Env } from '../src/index';

// Codex DS_SWAP R4: verification blocks must be fresh on the worker clock; pin Date to an hour after the fixture close.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: (CLOSE + 3600) * 1000 });
});
import { verifyPair } from '../src/crypto-datastreams';

const CLOSE = Number(fixture.observationsTimestamp);
const MARKET_COUNT = 119n; // nextMarketId on Monad testnet, 2026-10-12
const POOL = MARKET_COUNT - 1n;
const MAKO = '0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195';
const MAKO_RPC = 'http://mako-rpc.stub/';
const DS_SKEW_LIMIT_MS = 5_000;

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

/// Unresolved pools in the stub; the rest read as resolved. Data Streams answers `dsStatus` (404 = no report yet).
let liveIds = new Set<bigint>([POOL]);
let dsStatus = 200;

function market(id: bigint) {
  const live = liveIds.has(id);
  return {
    creator: resolverAddr,
    mType: 1,
    oracleRef: stringToHex('BTC:gt:75000', { size: 32 }),
    question: 'BTC above 75000?',
    createdAt: BigInt(CLOSE - 86_400),
    closeTime: BigInt(CLOSE),
    bettingCloseTime: BigInt(CLOSE - 60),
    totalYes: 10n ** 18n,
    totalNo: 10n ** 18n,
    yesBettorCount: 1,
    noBettorCount: 1,
    outcome: live ? 0 : 1,
    resolved: !live,
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

const dsSkews: number[] = [];
const verifyHosts: string[] = [];

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  if (url.startsWith('https://api.testnet-dataengine.chain.link/')) {
    const h = new Headers(init?.headers);
    const skew = Math.abs(Date.now() - Number(h.get('X-Authorization-Timestamp')));
    dsSkews.push(skew);
    if (skew > DS_SKEW_LIMIT_MS) return json({ error: 'unauthorized' }, 401);
    if (dsStatus !== 200) return json({ error: 'not found' }, dsStatus);
    return json({ report: { feedID: fixture.feedID, observationsTimestamp: CLOSE, fullReport: fixture.fullReport } });
  }
  const body = JSON.parse(String(init?.body));
  if (url === MAKO_RPC) return json(Array.isArray(body) ? body.map(makoAnswer) : makoAnswer(body));
  // Any other host is a verification provider here: record its hostname and answer as Monad would.
  verifyHosts.push(new URL(url).hostname);
  return json(verifyAnswer(body));
  throw new Error(`stub: unexpected request to ${url}`);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  liveIds = new Set([POOL]);
  dsStatus = 200;
  dsSkews.length = 0;
  verifyHosts.length = 0;
});

async function tick(alchemyUrl: string): Promise<string[]> {
  vi.stubGlobal('fetch', vi.fn(stubFetch));
  const lines: string[] = [];
  for (const k of ['log', 'warn', 'error'] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
  await runResolver({
    MAKO_ADDRESS: MAKO,
    MONAD_RPC_URL: MAKO_RPC,
    ADMIN_PRIVATE_KEY: key,
    DRY_RUN: '1',
    CRYPTO_PRICE_SOURCE: 'datastreams',
    DATASTREAMS_API_KEY: 'sentinel-ds-key',
    DATASTREAMS_API_SECRET: 'sentinel-ds-secret',
    ALCHEMY_RPC_URL: alchemyUrl,
  } as Env);
  return lines;
}

// Spec (1): "never the same operator twice and never the public Monad RPC; a missing, non-https or wrong URL makes
// crypto pools wait (nothing sent)". verifyPair compares the WHATWG hostname by string equality, and a fully qualified
// name with its root dot ("rpc.ankr.com.") is the same DNS name but a different string.
describe('adversary: the pair is Alchemy + Ankr, never one operator twice nor the public RPC', () => {
  it.each([
    ['Ankr as its own FQDN (same operator twice)', 'https://rpc.ankr.com./monad_testnet'],
    ['the public Monad RPC as its FQDN', 'https://testnet-rpc.monad.xyz./'],
    ['a host that is not Alchemy (wrong URL)', 'https://testnet-rpc.monad.xyz.evil/v2/sentinel-alchemy-key'],
  ])('verifyPair refuses %s', (_name, u) => {
    expect(verifyPair(u)).toBeNull();
  });

  it('end to end: ALCHEMY_RPC_URL = Ankr FQDN settles nothing; the pool waits', async () => {
    const lines = await tick('https://rpc.ankr.com./monad_testnet');
    const settled = lines.filter((l) => l.includes(`market ${POOL}:`) && l.includes('Chainlink Data Streams'));
    expect({ settled, verifyHosts: [...new Set(verifyHosts)] }).toEqual({ settled: [], verifyHosts: [] });
  }, 60_000);
});
