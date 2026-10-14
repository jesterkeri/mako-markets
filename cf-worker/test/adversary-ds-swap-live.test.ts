// Adversary on feat/ds-swap 167d774: runResolver in CRYPTO_PRICE_SOURCE=datastreams with DRY_RUN UNSET, end to end
// through its own wiring, down to the signed transaction it broadcasts.
//
// Every HTTP request of the tick is served by a stub installed as the global fetch: nothing leaves the machine and the
// "broadcast" lands in an array here.
//
//   * Mako V4 (MONAD_RPC_URL stub): owner/resolver = the test wallet; nextMarketId and the markets are per test, each
//     encoded with the repo's own ABI (src/abi.ts) through viem's encodeFunctionResult. The stub serves the whole
//     viem 2.50 send path the Worker uses: eth_fillTransaction answers -32601 (so viem falls back), then
//     eth_getBlockByNumber, eth_getTransactionCount, eth_estimateGas, eth_maxPriorityFeePerGas,
//     eth_sendRawTransaction, eth_blockNumber, eth_getTransactionReceipt.
//   * Data Streams API: the real BTC/USD report at 1789529160 in test/fixtures (captured 2026-09-23 from
//     api.testnet-dataengine.chain.link, see fixture `source`), price 75,938.791787880.
//   * Verification providers (Monad public RPC + Ankr): s_feeManager() = 0, verify() = the real verified payload of
//     that report, as in test/adversary-ds-swap.test.ts.
//   * CoinGecko: any request to api.coingecko.com is recorded and answered 500; spec 1 says there must be none.
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeFunctionResult,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  stringToHex,
  type Hex,
  type TransactionSerialized,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import fixture from './fixtures/fixture-btcusd-1789529160.json';
import { makoAbi } from '../src/abi';

// Codex DS_SWAP R4: verification blocks must be fresh on the worker clock; pin Date to an hour after the fixture close.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: (CLOSE + 3600) * 1000 });
});
import { runResolver, type Env } from '../src/index';

const CLOSE = Number(fixture.observationsTimestamp);
const MAKO = '0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195';
const MAKO_RPC = 'http://mako-rpc.stub/';
const CHAIN_ID = 10143;
const FINAL_BLOCK = 0x4400000n;
const DS_KEY = 'sentinel-ds-key-7f3a';
const DS_SECRET = 'sentinel-ds-secret-91c2';
const ALCHEMY_KEY = 'sentinel-alchemy-key-5d1e';

const payload = decodeAbiParameters(
  [{ type: 'bytes32[3]' }, { type: 'bytes' }, { type: 'bytes32[]' }, { type: 'bytes32[]' }, { type: 'bytes32' }],
  fixture.fullReport as Hex,
)[1].toLowerCase() as Hex;
const verifierAbi = [
  { type: 'function', name: 'verify', stateMutability: 'payable', inputs: [{ name: 'payload', type: 'bytes' }, { name: 'parameterPayload', type: 'bytes' }], outputs: [{ name: '', type: 'bytes' }] },
] as const;
const verifyReturnOf = (p: Hex) => encodeFunctionResult({ abi: verifierAbi, functionName: 'verify', result: p }).toLowerCase() as Hex;
const ZERO_WORD = `0x${'0'.repeat(64)}`;

const key = generatePrivateKey();
const resolverAddr = privateKeyToAccount(key).address;

// ---- per-test world ---------------------------------------------------------------------------------------------

type Pool = { mType: number; ref: string; yes?: bigint; no?: bigint };
let pools: Pool[] = [];
let dsStatus = 200;
let verifyPayload: Hex = payload;
let nonceLatest = 7;
let nonceFinal = 7;
/// Market ids that revert AlreadyResolved() (0x6d5703c2) at estimation, as Monad returns it.
let estimateRevertsFor = new Set<bigint>();

const raws: Hex[] = [];
const urls: string[] = [];
const sentHashes = new Set<string>();

function market(id: bigint) {
  const p = pools[Number(id)];
  return {
    creator: resolverAddr,
    mType: p.mType,
    oracleRef: stringToHex(p.ref, { size: 32 }),
    question: `pool ${id}`,
    createdAt: BigInt(CLOSE - 86_400),
    closeTime: BigInt(CLOSE),
    bettingCloseTime: BigInt(CLOSE - 60),
    totalYes: p.yes ?? 10n ** 6n,
    totalNo: p.no ?? 10n ** 6n,
    yesBettorCount: 1,
    noBettorCount: 1,
    outcome: 0,
    resolved: false,
    creatorFeeClaimed: false,
    protocolFeeBpsSnapshot: 0,
    creatorFeeBpsSnapshot: 0,
  };
}

const nowHex = () => `0x${Math.floor(Date.now() / 1000).toString(16)}`;
function block(number: bigint) {
  return {
    number: `0x${number.toString(16)}`,
    hash: `0x${number.toString(16).padStart(64, '0')}`,
    parentHash: ZERO_WORD,
    timestamp: nowHex(),
    baseFeePerGas: '0x174876e800',
    gasLimit: '0x1c9c380',
    gasUsed: '0x0',
    miner: '0x0000000000000000000000000000000000000000',
    extraData: '0x',
    logsBloom: `0x${'0'.repeat(512)}`,
    nonce: '0x0000000000000000',
    difficulty: '0x0',
    totalDifficulty: '0x0',
    sha3Uncles: ZERO_WORD,
    stateRoot: ZERO_WORD,
    receiptsRoot: ZERO_WORD,
    transactionsRoot: ZERO_WORD,
    mixHash: ZERO_WORD,
    size: '0x100',
    transactions: [],
    uncles: [],
  };
}

type Rpc = { id: number; jsonrpc: string; method: string; params?: unknown[] };
function makoAnswer(m: Rpc) {
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id: m.id, result });
  const err = (error: unknown) => ({ jsonrpc: '2.0', id: m.id, error });
  switch (m.method) {
    case 'eth_chainId':
      return ok(`0x${CHAIN_ID.toString(16)}`);
    case 'eth_blockNumber':
      return ok(`0x${(FINAL_BLOCK + 2n).toString(16)}`);
    case 'eth_getBlockByNumber': {
      const tag = m.params![0] as string;
      return ok(block(tag === 'finalized' ? FINAL_BLOCK : tag === 'latest' || tag === 'pending' ? FINAL_BLOCK + 2n : BigInt(tag)));
    }
    case 'eth_getTransactionCount': {
      const tag = m.params![1] as string;
      return ok(`0x${(tag === 'latest' || tag === 'pending' ? nonceLatest : nonceFinal).toString(16)}`);
    }
    case 'eth_fillTransaction':
      return err({ code: -32601, message: 'Method not found' });
    case 'eth_maxPriorityFeePerGas':
      return ok('0x77359400');
    case 'eth_gasPrice':
      return ok('0x174876e800');
    case 'eth_estimateGas': {
      const d = decodeFunctionData({ abi: makoAbi, data: (m.params![0] as { data: Hex }).data });
      if (d.functionName === 'resolveMarket' && estimateRevertsFor.has((d.args as [bigint])[0])) {
        return err({ code: 3, message: 'execution reverted', data: '0x6d5703c2' });
      }
      return ok('0x30000');
    }
    case 'eth_sendRawTransaction': {
      const raw = m.params![0] as Hex;
      raws.push(raw);
      const h = keccak256(raw);
      sentHashes.add(h);
      return ok(h);
    }
    case 'eth_getTransactionReceipt': {
      const h = m.params![0] as string;
      if (!sentHashes.has(h)) return ok(null);
      return ok({
        transactionHash: h,
        transactionIndex: '0x0',
        blockHash: `0x${(FINAL_BLOCK + 1n).toString(16).padStart(64, '0')}`,
        blockNumber: `0x${(FINAL_BLOCK + 1n).toString(16)}`,
        from: resolverAddr.toLowerCase(),
        to: MAKO.toLowerCase(),
        cumulativeGasUsed: '0x20000',
        gasUsed: '0x20000',
        effectiveGasPrice: '0x174876e800',
        contractAddress: null,
        logs: [],
        logsBloom: `0x${'0'.repeat(512)}`,
        status: '0x1',
        type: '0x2',
      });
    }
    case 'eth_call': {
      const d = decodeFunctionData({ abi: makoAbi, data: (m.params![0] as { data: Hex }).data });
      const result =
        d.functionName === 'owner' || d.functionName === 'resolver'
          ? encodeFunctionResult({ abi: makoAbi, functionName: d.functionName, result: resolverAddr })
          : d.functionName === 'nextMarketId'
            ? encodeFunctionResult({ abi: makoAbi, functionName: 'nextMarketId', result: BigInt(pools.length) })
            : encodeFunctionResult({ abi: makoAbi, functionName: 'getMarket', result: market((d.args as [bigint])[0]) as never });
      return ok(result);
    }
    default:
      return err({ code: -32601, message: `stub: ${m.method}` });
  }
}

/// Codex DS_SWAP R4 regression: when set, Alchemy names an OLD but real finalized block (a block both providers know,
/// with its true hash and timestamp); Ankr names the real current one. Both accept eth_call at either block.
let alchemyOldFinalized = false;
const HEAD = 0x4337013n;
const OLD = HEAD - 100_000n;
const blockAt = (n: bigint) => ({
  number: `0x${n.toString(16)}`,
  // the old block is ~8 hours older than now (100,000 blocks at ~0.3 s), the head is current
  timestamp: `0x${(Math.floor(Date.now() / 1000) - (n === OLD ? 30_000 : 1)).toString(16)}`,
  hash: `0x${n.toString(16).padStart(64, '0')}`,
});
function verifyAnswer(m: Rpc, alchemy = false) {
  if (m.method === 'eth_getBlockByNumber') {
    const tag = m.params![0] as string;
    const n = tag === 'finalized' ? (alchemy && alchemyOldFinalized ? OLD : HEAD) : BigInt(tag);
    return { jsonrpc: '2.0', id: m.id, result: blockAt(n) };
  }
  const data = (m.params![0] as { data: string }).data;
  return { jsonrpc: '2.0', id: m.id, result: data.length <= 10 ? ZERO_WORD : verifyReturnOf(verifyPayload) };
}

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  urls.push(url);
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  if (url.includes('coingecko')) return json({ error: 'stub: coingecko must not be called in datastreams mode' }, 500);
  if (url.startsWith('https://api.testnet-dataengine.chain.link/')) {
    if (dsStatus !== 200) return json({ error: 'not found' }, dsStatus);
    return json({ report: { feedID: fixture.feedID, observationsTimestamp: CLOSE, fullReport: fixture.fullReport } });
  }
  const body = JSON.parse(String(init?.body));
  if (url === MAKO_RPC) return json(Array.isArray(body) ? body.map(makoAnswer) : makoAnswer(body));
  if (url.startsWith('https://testnet-rpc.monad.xyz') || url.startsWith('https://monad-testnet.g.alchemy.com') || url.startsWith('https://rpc.ankr.com/monad_testnet')) {
    return json(verifyAnswer(body, url.startsWith('https://monad-testnet.g.alchemy.com')));
  }
  throw new Error(`stub: unexpected request to ${url}`);
}

const env = (): Env =>
  ({
    MAKO_ADDRESS: MAKO,
    MONAD_RPC_URL: MAKO_RPC,
    ADMIN_PRIVATE_KEY: key,
    CRYPTO_PRICE_SOURCE: 'datastreams',
    DATASTREAMS_API_KEY: DS_KEY,
    DATASTREAMS_API_SECRET: DS_SECRET,
    ALCHEMY_RPC_URL: `https://monad-testnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  }) as Env;

async function tick(): Promise<string[]> {
  vi.stubGlobal('fetch', vi.fn(stubFetch));
  const lines: string[] = [];
  for (const k of ['log', 'warn', 'error'] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
  await runResolver(env());
  return lines;
}

/// Every raw transaction broadcast, decoded: signer, target, chain, nonce and the resolveMarket call.
async function sent() {
  return Promise.all(
    raws.map(async (raw) => {
      const tx = parseTransaction(raw as TransactionSerialized);
      const call = decodeFunctionData({ abi: makoAbi, data: tx.data! });
      return {
        from: await recoverTransactionAddress({ serializedTransaction: raw as TransactionSerialized }),
        to: tx.to!.toLowerCase(),
        chainId: tx.chainId,
        nonce: tx.nonce,
        fn: call.functionName,
        args: (call.args as readonly unknown[]).map((a) => (typeof a === 'bigint' ? Number(a) : a)),
      };
    }),
  );
}

const evidence = (lines: string[]) => lines.filter((l) => l.includes('"event":"crypto.ds.evidence"')).map((l) => JSON.parse(l));
const dsRequests = () => urls.filter((u) => u.startsWith('https://api.testnet-dataengine.chain.link/')).length;
const noSecrets = (lines: string[]) => {
  for (const s of [DS_KEY, DS_SECRET, ALCHEMY_KEY, key.slice(2), key.slice(2, 34)]) expect(lines.join('\n')).not.toContain(s);
};

const BTC_YES = 'BTC:gt:75000'; // 75,938.79 > 75,000: YES
const BTC_NO = 'BTC:gt:76000'; // 75,938.79 > 76,000 is false: NO
const BTC_LT_YES = 'BTC:lt:76000'; // 75,938.79 < 76,000: YES
const BTC_AT = 'BTC:gt:75938.79178788'; // exactly the report price: NO
const CRYPTO = 1;
const FOOTBALL = 0;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  pools = [];
  dsStatus = 200;
  verifyPayload = payload;
  nonceLatest = 7;
  nonceFinal = 7;
  estimateRevertsFor = new Set();
  raws.length = 0;
  urls.length = 0;
  sentHashes.clear();
});

describe('adversary: datastreams LIVE (DRY_RUN unset), the signed transaction itself', () => {
  for (const [ref, outcome] of [
    [BTC_YES, 1],
    [BTC_NO, 2],
    [BTC_LT_YES, 1],
    [BTC_AT, 2],
  ] as const) {
    it(`${ref}: broadcasts exactly resolveMarket(0, ${outcome}) from the resolver, and the evidence matches it`, async () => {
      pools = [{ mType: CRYPTO, ref }];
      const lines = await tick();
      expect(await sent()).toEqual([{ from: resolverAddr, to: MAKO.toLowerCase(), chainId: CHAIN_ID, nonce: 7, fn: 'resolveMarket', args: [0, outcome] }]);
      const ev = evidence(lines);
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ market: 0, outcome: outcome === 1 ? 'YES' : 'NO', observationsTimestamp: String(CLOSE), price: '75938791787880000000000' });
      const resolved = lines.find((l) => l.includes('market 0: RESOLVED'));
      expect(resolved).toBeTruthy();
      // The evidence names the transaction that went out (fix after this pass: logged only after the send).
      const tx = /tx (0x[0-9a-f]{64})/.exec(resolved!)![1];
      expect(ev[0]).toMatchObject({ send: 'landed', tx });
      expect(urls.filter((u) => u.includes('coingecko'))).toEqual([]);
      noSecrets(lines);
    }, 60_000);
  }

  it('wait (no report yet): no transaction', async () => {
    pools = [{ mType: CRYPTO, ref: BTC_YES }];
    dsStatus = 404;
    const lines = await tick();
    expect(raws).toEqual([]);
    expect(evidence(lines)).toEqual([]);
    expect(lines.some((l) => l.includes('datastreams wait (report_report_missing)'))).toBe(true);
  }, 60_000);

  it('final (verifier bytes of the wrong schema): no transaction', async () => {
    pools = [{ mType: CRYPTO, ref: BTC_YES }];
    verifyPayload = `0x0008${payload.slice(6)}` as Hex;
    const lines = await tick();
    expect(raws).toEqual([]);
    expect(evidence(lines)).toEqual([]);
    expect(lines.some((l) => l.includes('datastreams final (wrong_report)'))).toBe(true);
  }, 60_000);

  it('no credentials: no transaction and no Data Streams or CoinGecko request', async () => {
    pools = [{ mType: CRYPTO, ref: BTC_YES }];
    vi.stubGlobal('fetch', vi.fn(stubFetch));
    for (const k of ['log', 'warn', 'error'] as const) vi.spyOn(console, k).mockImplementation(() => {});
    await runResolver({ ...env(), DATASTREAMS_API_SECRET: '  ' } as Env);
    expect(raws).toEqual([]);
    expect(urls.filter((u) => u.includes('coingecko') || u.includes('dataengine'))).toEqual([]);
  }, 60_000);

  it('a symbol with no pinned feed (XRP) waits; no Data Streams or CoinGecko request, no transaction', async () => {
    pools = [{ mType: CRYPTO, ref: 'XRP:gt:0.5' }];
    const lines = await tick();
    expect(raws).toEqual([]);
    expect(urls.filter((u) => u.includes('coingecko') || u.includes('dataengine'))).toEqual([]);
    expect(evidence(lines)).toEqual([]);
  }, 60_000);

  it('two crypto pools in one tick: one transaction, for the lower id, and only its evidence', async () => {
    pools = [{ mType: CRYPTO, ref: BTC_NO }, { mType: CRYPTO, ref: BTC_YES }];
    const lines = await tick();
    expect(await sent()).toMatchObject([{ fn: 'resolveMarket', args: [0, 2] }]);
    expect(evidence(lines).map((e) => [e.market, e.outcome])).toEqual([[0, 'NO']]);
    expect(dsRequests()).toBe(1); // the second pool is deferred before its evaluation
    expect(lines.some((l) => l.includes('market 1: resolveMarket deferred to the next tick'))).toBe(true);
  }, 60_000);

  it('first pool already resolved at estimation: slot returns, the second pool is sent with its own outcome', async () => {
    pools = [{ mType: CRYPTO, ref: BTC_YES }, { mType: CRYPTO, ref: BTC_NO }];
    estimateRevertsFor = new Set([0n]);
    const lines = await tick();
    expect(await sent()).toMatchObject([{ fn: 'resolveMarket', args: [1, 2] }]);
    const ev = evidence(lines).map((e) => [e.market, e.outcome]);
    expect(ev).toContainEqual([1, 'NO']);
  }, 60_000);

  it('Codex R4: Alchemy names an old real block (Ankr accepts calls at it): the pool waits (block_stale), no transaction', async () => {
    alchemyOldFinalized = true;
    try {
      pools = [{ mType: CRYPTO, ref: BTC_YES }];
      const lines = await tick();
      expect(await sent()).toEqual([]);
      expect(lines.some((l) => l.includes('datastreams wait (block_stale)'))).toBe(true);
      expect(evidence(lines)).toEqual([]);
    } finally {
      alchemyOldFinalized = false;
    }
  }, 60_000);

  it('a one-sided pool past close + 24 h earlier in the tick takes the slot (forceRefund); the crypto pool is deferred unevaluated', async () => {
    vi.setSystemTime((CLOSE + 25 * 3600) * 1000); // past close + 24 h (the clock is pinned near close by default)
    pools = [{ mType: FOOTBALL, ref: 'FB:1:home_win', no: 0n }, { mType: CRYPTO, ref: BTC_YES }];
    const lines = await tick();
    expect(await sent()).toMatchObject([{ fn: 'forceRefund', args: [0] }]);
    expect(dsRequests()).toBe(0);
    expect(evidence(lines)).toEqual([]);
  }, 60_000);

  it('a one-sided pool inside 24 h earlier in the tick takes the slot (resolveMarket REFUND); the crypto pool is deferred unevaluated', async () => {
    // Only Date is faked: the tick runs 10 minutes after the fixture's close second.
    vi.useFakeTimers({ toFake: ['Date'], now: (CLOSE + 600) * 1000 });
    try {
      pools = [{ mType: FOOTBALL, ref: 'FB:1:home_win', no: 0n }, { mType: CRYPTO, ref: BTC_YES }];
      const lines = await tick();
      expect(await sent()).toMatchObject([{ fn: 'resolveMarket', args: [0, 3] }]);
      expect(dsRequests()).toBe(0);
      expect(evidence(lines)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);

  it('inside 24 h: a two-sided crypto pool settles from Data Streams exactly as past 24 h', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: (CLOSE + 600) * 1000 });
    try {
      pools = [{ mType: CRYPTO, ref: BTC_NO }];
      const lines = await tick();
      expect(await sent()).toMatchObject([{ fn: 'resolveMarket', args: [0, 2] }]);
      expect(evidence(lines).map((e) => [e.market, e.outcome])).toEqual([[0, 'NO']]);
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);

  it('a crypto pool that waits (API answers another feed) gives the slot to the next crypto pool, sent with its own outcome', async () => {
    pools = [{ mType: CRYPTO, ref: 'ETH:gt:1000' }, { mType: CRYPTO, ref: BTC_NO }];
    const lines = await tick();
    expect(await sent()).toMatchObject([{ fn: 'resolveMarket', args: [1, 2] }]);
    expect(evidence(lines).map((e) => [e.market, e.outcome])).toEqual([[1, 'NO']]);
    expect(lines.some((l) => l.includes('market 0: datastreams wait (report_mismatch)'))).toBe(true);
  }, 60_000);

  it('a non-crypto two-sided pool earlier that cannot resolve (no football key) leaves the crypto pool its send', async () => {
    pools = [{ mType: FOOTBALL, ref: 'FB:1:home_win' }, { mType: CRYPTO, ref: BTC_NO }];
    const lines = await tick();
    expect(await sent()).toMatchObject([{ fn: 'resolveMarket', args: [1, 2] }]);
    expect(evidence(lines).map((e) => [e.market, e.outcome])).toEqual([[1, 'NO']]);
    expect(urls.filter((u) => u.includes('coingecko'))).toEqual([]);
  }, 60_000);

  // Spec 3: "The evidence line logged for a pool describes exactly the report used for the transaction sent for that
  // pool (same market, same outcome)". Here the resolver's previous transaction is landed but not final (nonce 8 at
  // latest, 7 at the finalized block), so sendOnce refuses to send. An evidence line must not stand for a settlement
  // that was never sent.
  it('no transaction sent (previous resolver tx not final): no evidence line claims a settlement', async () => {
    pools = [{ mType: CRYPTO, ref: BTC_NO }];
    nonceLatest = 8;
    nonceFinal = 7;
    const lines = await tick();
    expect(raws).toEqual([]);
    expect({ evidence: evidence(lines).map((e) => [e.market, e.outcome]) }).toEqual({ evidence: [] });
  }, 60_000);

  it('already resolved at estimation (nothing broadcast): no evidence line claims a settlement', async () => {
    pools = [{ mType: CRYPTO, ref: BTC_YES }];
    estimateRevertsFor = new Set([0n]);
    const lines = await tick();
    expect(raws).toEqual([]);
    expect({ evidence: evidence(lines).map((e) => [e.market, e.outcome]) }).toEqual({ evidence: [] });
  }, 60_000);
});
