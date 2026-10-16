// Forex / metals / stocks on Chainlink Data Streams v8 (feat/ds-rwa), whole tick: runResolver with DRY_RUN unset,
// down to the signed transaction, on the harness of adversary-ds-swap-live.test.ts. Data Streams serves real reports
// by feed and second: BTC/USD at 1789529160, EUR/USD OPEN at 1789735483 (mid 1.14633) and EUR/USD CLOSED on a Saturday
// at 1789214400 (mid 1.1598825, Friday's last price). Pyth Hermes requests are recorded and answered 500.
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
import eurOpen from './fixtures/fixture-eurusd-1789735483.json';
import eurClosed from './fixtures/fixture-eurusd-1789214400.json';
import { makoAbi } from '../src/abi';

// An hour after the latest fixture close: every pool has closed and no report has expired (BTC expires 1792121160,
// EUR closed 1791806400, EUR open 1792327483).
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: (EUR_OPEN + 3600) * 1000 });
});
import { runResolver, type Env } from '../src/index';

const CLOSE = Number(fixture.observationsTimestamp);
const EUR_OPEN = Number(eurOpen.observationsTimestamp);
const EUR_CLOSED = Number(eurClosed.observationsTimestamp);
const MAKO = '0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195';
const MAKO_RPC = 'http://mako-rpc.stub/';
const CHAIN_ID = 10143;
const FINAL_BLOCK = 0x4400000n;
const DS_KEY = 'sentinel-ds-key-7f3a';
const DS_SECRET = 'sentinel-ds-secret-91c2';
const ALCHEMY_KEY = 'sentinel-alchemy-key-5d1e';

const payloadOf = (full: string) =>
  decodeAbiParameters([{ type: 'bytes32[3]' }, { type: 'bytes' }, { type: 'bytes32[]' }, { type: 'bytes32[]' }, { type: 'bytes32' }], full as Hex)[1].toLowerCase() as Hex;
const payload = payloadOf(fixture.fullReport);
/// The real reports by feed and observed second.
const REPORTS = [fixture, eurOpen, eurClosed].map((f) => ({ feedID: f.feedID.toLowerCase(), ts: Number(f.observationsTimestamp), full: f.fullReport, payload: payloadOf(f.fullReport) }));
const verifierAbi = [
  { type: 'function', name: 'verify', stateMutability: 'payable', inputs: [{ name: 'payload', type: 'bytes' }, { name: 'parameterPayload', type: 'bytes' }], outputs: [{ name: '', type: 'bytes' }] },
] as const;
const verifyReturnOf = (p: Hex) => encodeFunctionResult({ abi: verifierAbi, functionName: 'verify', result: p }).toLowerCase() as Hex;
const ZERO_WORD = `0x${'0'.repeat(64)}`;

const key = generatePrivateKey();
const resolverAddr = privateKeyToAccount(key).address;

// ---- per-test world ---------------------------------------------------------------------------------------------

type Pool = { mType: number; ref: string; close: number; yes?: bigint; no?: bigint };
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
    createdAt: BigInt(p.close - 86_400),
    closeTime: BigInt(p.close),
    bettingCloseTime: BigInt(p.close - 60),
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

/// Codex DS_SWAP R4 regression switch, copied from adversary-ds-swap-live.test.ts and never set here: both providers
/// always name the current block in this file. The stale-block case for forex pools is adversary-rwa-block-stale.test.ts.
const alchemyOldFinalized = false;
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
  if (data.length <= 10) return { jsonrpc: '2.0', id: m.id, result: ZERO_WORD };
  const submitted = decodeFunctionData({ abi: verifierAbi, data: data as Hex }).args[0] as Hex;
  const r = REPORTS.find((x) => payloadOf(x.full) === payloadOf(submitted));
  return { jsonrpc: '2.0', id: m.id, result: verifyReturnOf(r ? r.payload : verifyPayload) };
}

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  urls.push(url);
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  if (url.includes('coingecko')) return json({ error: 'stub: coingecko must not be called in datastreams mode' }, 500);
  if (url.includes('hermes.pyth.network')) return json({ error: 'stub: pyth answers 500' }, 500);
  if (url.startsWith('https://api.testnet-dataengine.chain.link/')) {
    if (dsStatus !== 200) return json({ error: 'not found' }, dsStatus);
    const q = new URL(url).searchParams;
    const r = REPORTS.find((x) => x.feedID === q.get('feedID')?.toLowerCase() && x.ts === Number(q.get('timestamp')));
    if (!r) return json({ error: 'not found' }, 404);
    return json({ report: { feedID: r.feedID, observationsTimestamp: r.ts, fullReport: r.full } });
  }
  const body = JSON.parse(String(init?.body));
  if (url === MAKO_RPC) return json(Array.isArray(body) ? body.map(makoAnswer) : makoAnswer(body));
  if (url.startsWith('https://testnet-rpc.monad.xyz') || url.startsWith('https://monad-testnet.g.alchemy.com') || url.startsWith('https://rpc.ankr.com/monad_testnet')) {
    return json(verifyAnswer(body, url.startsWith('https://monad-testnet.g.alchemy.com')));
  }
  throw new Error(`stub: unexpected request to ${url}`);
}

let rwaSource = 'datastreams';
let cryptoSource = 'datastreams';
const env = (): Env =>
  ({
    MAKO_ADDRESS: MAKO,
    MONAD_RPC_URL: MAKO_RPC,
    ADMIN_PRIVATE_KEY: key,
    CRYPTO_PRICE_SOURCE: cryptoSource,
    RWA_PRICE_SOURCE: rwaSource,
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

const evidence = (lines: string[]) => lines.filter((l) => l.includes('"event":"rwa.ds.evidence"')).map((l) => JSON.parse(l));
const dsRequests = () => urls.filter((u) => u.startsWith('https://api.testnet-dataengine.chain.link/')).length;
const noSecrets = (lines: string[]) => {
  for (const s of [DS_KEY, DS_SECRET, ALCHEMY_KEY, key.slice(2), key.slice(2, 34)]) expect(lines.join('\n')).not.toContain(s);
};

const CRYPTO = 1;
const FOREX = 3;
const STOCKS = 5;
const hermes = () => urls.filter((u) => u.includes('hermes.pyth.network'));

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
  rwaSource = 'datastreams';
  cryptoSource = 'datastreams';
  raws.length = 0;
  urls.length = 0;
  sentHashes.clear();
});


describe('forex / metals / stocks on Data Streams v8, whole tick (DRY_RUN unset)', () => {
  for (const [ref, close, outcome, status] of [
    ['EURUSD:gt:1.14', 'open', 1, '2'],
    ['EURUSD:gt:1.15', 'open', 2, '2'],
    ['EURUSD:lt:1.15', 'open', 1, '2'],
    ['EURUSD:gt:1.14633', 'open', 2, '2'], // exactly the mid: NO
    ['EURUSD:gt:1.15', 'closed', 1, '1'], // closed market: Friday's last price 1.1598825
    ['EURUSD:lt:1.15', 'closed', 2, '1'],
  ] as const) {
    it(`${ref} (${close} market): broadcasts exactly resolveMarket(0, ${outcome}), evidence says status ${status}, no Pyth call`, async () => {
      pools = [{ mType: FOREX, ref, close: close === 'open' ? EUR_OPEN : EUR_CLOSED }];
      const lines = await tick();
      expect(await sent()).toEqual([{ from: resolverAddr, to: MAKO.toLowerCase(), chainId: CHAIN_ID, nonce: 7, fn: 'resolveMarket', args: [0, outcome] }]);
      const ev = evidence(lines);
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ market: 0, outcome: outcome === 1 ? 'YES' : 'NO', marketStatus: status, observationsTimestamp: String(close === 'open' ? EUR_OPEN : EUR_CLOSED) });
      // The decision line before the send names the closed-market rule; an open market's does not.
      expect(lines.some((l) => l.includes('market 0: EURUSD vs strike') && l.includes('market closed: last traded price'))).toBe(close === 'closed');
      expect(hermes()).toEqual([]);
      noSecrets(lines);
    }, 60_000);
  }

  it('a symbol without a feed, or a class mismatch, sends nothing and asks Data Streams nothing', async () => {
    pools = [
      { mType: FOREX, ref: 'EURGBP:gt:0.8', close: EUR_OPEN },
      { mType: STOCKS, ref: 'EURUSD:gt:1.14', close: EUR_OPEN },
    ];
    const lines = await tick();
    expect(raws).toEqual([]);
    expect(dsRequests()).toBe(0);
    expect(hermes()).toEqual([]);
    noSecrets(lines);
  }, 60_000);

  it('a ref with a trailing tab (accepted by the sponsor) settles too (adversary on 67a1cbe)', async () => {
    pools = [{ mType: FOREX, ref: 'EURUSD:gt:1.14\t', close: EUR_OPEN }];
    await tick();
    expect(await sent()).toEqual([{ from: resolverAddr, to: MAKO.toLowerCase(), chainId: CHAIN_ID, nonce: 7, fn: 'resolveMarket', args: [0, 1] }]);
  }, 60_000);

  it('shadow mode: forex pools never take a live crypto pool\'s Data Streams slot (adversary on 67a1cbe)', async () => {
    rwaSource = 'datastreams-shadow';
    pools = [
      { mType: CRYPTO, ref: 'BTC:gt:75000', close: CLOSE },
      { mType: CRYPTO, ref: 'BTC:gt:76000', close: CLOSE },
      { mType: FOREX, ref: 'EURUSD:gt:1.14', close: EUR_OPEN },
    ];
    const lines = await tick();
    // The first crypto pool is evaluated and settled this tick; with shared slots it lost its turn this minute.
    expect(lines.some((l) => l.includes("market 0: datastreams not this tick's turn"))).toBe(false);
    expect(await sent()).toEqual([{ from: resolverAddr, to: MAKO.toLowerCase(), chainId: CHAIN_ID, nonce: 7, fn: 'resolveMarket', args: [0, 1] }]);
    // The forex pool was only logged (its own slot), never sent from Data Streams.
    expect(evidence(lines)).toEqual([]);
  }, 60_000);

  it('reverse: crypto in shadow, forex live: crypto logging never takes the forex pool\'s live slot (Codex DS_RWA R1)', async () => {
    cryptoSource = 'datastreams-shadow';
    pools = [
      { mType: CRYPTO, ref: 'BTC:gt:75000', close: CLOSE },
      { mType: CRYPTO, ref: 'BTC:gt:76000', close: CLOSE },
      { mType: CRYPTO, ref: 'BTC:lt:76000', close: CLOSE },
      { mType: FOREX, ref: 'EURUSD:gt:1.14', close: EUR_OPEN },
    ];
    const lines = await tick();
    expect(lines.some((l) => l.includes("market 3: datastreams not this tick's turn"))).toBe(false);
    // Crypto pools follow CoinGecko (answering 500 here), so nothing settles them; the forex pool settles on Data Streams.
    expect(await sent()).toEqual([{ from: resolverAddr, to: MAKO.toLowerCase(), chainId: CHAIN_ID, nonce: 7, fn: 'resolveMarket', args: [3, 1] }]);
    expect(evidence(lines)).toHaveLength(1);
  }, 60_000);
});
