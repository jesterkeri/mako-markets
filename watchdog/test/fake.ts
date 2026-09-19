// A fake world for whole-run tests: provider B and the public RPC answer
// JSON-RPC from an in-memory market list (getMarket results ABI-encoded with
// viem, independently of the watchdog's hand decoder), plus fake Telegram,
// Healthchecks and app endpoints, and a controllable clock.

import { decodeFunctionData, encodeAbiParameters, parseAbi, stringToHex, type Hex } from 'viem';
import { CHAIN_ID, MULTICALL3 } from '../src/config';
import type { Deps, RunEnv } from '../src/run';

export const MAKO = '0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195';
export const RESOLVER = '0xC8BF886f73E4371CBd8160EEA7683b8Da98190F1';
export const PROVIDER_B = 'https://providerb.test/v2/SECRET-KEY';
export const PUBLIC_RPC = 'https://publicrpc.test/';
export const APP = 'https://app.test';
export const HC = 'https://hc-ping.test/0000-uuid';

const MARKET_COMPONENTS = [
  { name: 'creator', type: 'address' },
  { name: 'mType', type: 'uint8' },
  { name: 'oracleRef', type: 'bytes32' },
  { name: 'question', type: 'string' },
  { name: 'createdAt', type: 'uint64' },
  { name: 'closeTime', type: 'uint64' },
  { name: 'bettingCloseTime', type: 'uint64' },
  { name: 'totalYes', type: 'uint256' },
  { name: 'totalNo', type: 'uint256' },
  { name: 'yesBettorCount', type: 'uint32' },
  { name: 'noBettorCount', type: 'uint32' },
  { name: 'outcome', type: 'uint8' },
  { name: 'resolved', type: 'bool' },
  { name: 'creatorFeeClaimed', type: 'bool' },
  { name: 'protocolFeeBpsSnapshot', type: 'uint16' },
  { name: 'creatorFeeBpsSnapshot', type: 'uint16' },
] as const;

export interface FakeMarket {
  mType: number;
  ref: string;
  createdAt: number;
  closeTime: number;
  bettingCloseTime: number;
  yes: bigint;
  no: bigint;
  resolved: boolean;
  outcome?: number;
}

export function encodeMarket(m: FakeMarket | null): Hex {
  const v = m ?? { mType: 0, ref: '', createdAt: 0, closeTime: 0, bettingCloseTime: 0, yes: 0n, no: 0n, resolved: false };
  return encodeAbiParameters([{ type: 'tuple', components: MARKET_COMPONENTS }], [
    {
      creator: m ? '0x00000000000000000000000000000000000000aa' : '0x0000000000000000000000000000000000000000',
      mType: v.mType,
      oracleRef: v.ref ? stringToHex(v.ref, { size: 32 }) : `0x${'0'.repeat(64)}`,
      question: m ? `question ${v.ref}` : '',
      createdAt: BigInt(v.createdAt),
      closeTime: BigInt(v.closeTime),
      bettingCloseTime: BigInt(v.bettingCloseTime),
      totalYes: v.yes,
      totalNo: v.no,
      yesBettorCount: v.yes > 0n ? 1 : 0,
      noBettorCount: v.no > 0n ? 1 : 0,
      outcome: m?.outcome ?? (v.resolved ? 3 : 0),
      resolved: v.resolved,
      creatorFeeClaimed: false,
      protocolFeeBpsSnapshot: 100,
      creatorFeeBpsSnapshot: 200,
    },
  ]);
}

const mcAbi = parseAbi(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])']);

export interface World {
  clock: { t: number };
  markets: FakeMarket[];
  /// Overrides nextMarketId as reported by provider B.
  reportedN?: number;
  finalizedBlock: number;
  latestBlock: number;
  resolver: string;
  balanceWei: bigint;
  /// Provider B: HTTP page requests (by 0-based page index this run) that fail.
  failPages: Set<number>;
  /// Ids whose call fails inside aggregate3 (success = false).
  failIds: Set<number>;
  providerDown: boolean;
  publicDown: boolean;
  publicLatest?: number;
  /// The public RPC's own view, when it should disagree with provider B.
  publicMarkets?: FakeMarket[];
  publicBlockHash?: string;
  publicChainId?: number;
  /// Provider B's view of the chain, when it should lie.
  providerChainId?: number;
  providerTimestampOffsetS?: number;
  providerLatestOverride?: number;
  providerFinalizedOverride?: number;
  /// Finalized block time for this run; tick() fixes it so both providers agree.
  finalizedTs?: number;
  telegram: {
    mode: 'ok' | 'fail' | '429';
    retryAfter: number;
    sent: string[];
    fail429Once?: boolean;
    /// Accept only this many messages in a run, then fail (partial delivery).
    okMessages?: number;
  };
  hc: { mode: 'ok' | 'not_found' | 'rate_limited' | 'no_header' | 'small_header' | '500' | 'timeout'; pings: { url: string; body: string }[] };
  app: { comments: boolean; market: boolean; charts: boolean };
  /// Every request, as "<host> <what>".
  log: string[];
  /// Every request times out after 10 s of fake time.
  allTimeout: boolean;
  pageRequestIndex: number;
  /// Milliseconds of fake time each request takes.
  latencyMs: number;
  /// Model the real concurrency: each host is its own lane (one request in
  /// flight per provider), lanes run in parallel, and the clock is the latest
  /// finish. Off by default, which serialises time and so overstates it.
  concurrent?: boolean;
  lanes?: Record<string, number>;
}

export function makeWorld(partial: Partial<World> = {}): World {
  return {
    clock: { t: Date.UTC(2026, 8, 19, 12, 5) },
    markets: [],
    finalizedBlock: 63_000_000,
    latestBlock: 63_000_002,
    resolver: RESOLVER.toLowerCase(),
    balanceWei: 19n * 10n ** 18n,
    failPages: new Set(),
    failIds: new Set(),
    providerDown: false,
    publicDown: false,
    telegram: { mode: 'ok', retryAfter: 1, sent: [] },
    hc: { mode: 'ok', pings: [] },
    app: { comments: true, market: true, charts: true },
    log: [],
    allTimeout: false,
    pageRequestIndex: 0,
    latencyMs: 20,
    ...partial,
  };
}

function rpcResult(id: number, result: unknown) {
  return { jsonrpc: '2.0', id, result };
}

function word(v: bigint | number | string): Hex {
  if (typeof v === 'string') return `0x${v.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
  return `0x${BigInt(v).toString(16).padStart(64, '0')}`;
}

function answerRpc(w: World, calls: { id: number; method: string; params: unknown[] }[], isProviderB: boolean): unknown {
  const n = w.reportedN ?? w.markets.length;
  const baseTs = w.finalizedTs ?? Math.floor(w.clock.t / 1000);
  const finTs = isProviderB ? baseTs + (w.providerTimestampOffsetS ?? 0) : baseTs;
  const markets = isProviderB ? w.markets : (w.publicMarkets ?? w.markets);
  const chainId = isProviderB ? (w.providerChainId ?? CHAIN_ID) : (w.publicChainId ?? CHAIN_ID);
  const latest = isProviderB ? (w.providerLatestOverride ?? w.latestBlock) : (w.publicLatest ?? w.latestBlock);
  const finalized = isProviderB ? (w.providerFinalizedOverride ?? w.finalizedBlock) : w.finalizedBlock;
  const hash = isProviderB ? '0x' + '11'.repeat(32) : (w.publicBlockHash ?? '0x' + '11'.repeat(32));
  return calls.map((c) => {
    switch (c.method) {
      case 'eth_chainId':
        return rpcResult(c.id, `0x${chainId.toString(16)}`);
      case 'eth_blockNumber':
        return rpcResult(c.id, `0x${latest.toString(16)}`);
      case 'eth_getBlockByNumber':
        return rpcResult(c.id, { number: `0x${finalized.toString(16)}`, timestamp: `0x${finTs.toString(16)}`, hash });
      case 'eth_getBalance':
        return rpcResult(c.id, `0x${w.balanceWei.toString(16)}`);
      case 'eth_call': {
        const p = c.params[0] as { to: string; data: string };
        if (p.to.toLowerCase() === MAKO.toLowerCase()) {
          if (p.data === '0x406ef2ef') return rpcResult(c.id, word(n));
          if (p.data === '0x04f3bcec') return rpcResult(c.id, word(w.resolver));
        }
        if (p.to.toLowerCase() === MULTICALL3.toLowerCase()) {
          const { args } = decodeFunctionData({ abi: mcAbi, data: p.data as Hex });
          const results = (args[0] as readonly { callData: Hex }[]).map((call) => {
            const id = Number(BigInt('0x' + call.callData.slice(10)));
            if (w.failIds.has(id)) return { success: false, returnData: '0x' as Hex };
            return { success: true, returnData: encodeMarket(markets[id] ?? null) };
          });
          return rpcResult(c.id, encodeAbiParameters([{ type: 'tuple[]', components: [{ type: 'bool', name: 'success' }, { type: 'bytes', name: 'returnData' }] }], [results]));
        }
        return { jsonrpc: '2.0', id: c.id, error: { code: 3, message: 'execution reverted' } };
      }
      default:
        return { jsonrpc: '2.0', id: c.id, error: { code: -32601, message: 'no method' } };
    }
  });
}

export function makeFetch(w: World): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const host = new URL(url).host;
    const spend = (ms: number) => {
      if (!w.concurrent) {
        w.clock.t += ms;
        return;
      }
      w.lanes ??= {};
      const start = w.lanes[host] ?? w.clock.t;
      w.lanes[host] = start + ms;
      w.clock.t = Math.max(w.clock.t, w.lanes[host]);
    };
    if (w.allTimeout) {
      spend(10_000);
      w.log.push(`${host} timeout`);
      throw new DOMException('timed out', 'TimeoutError');
    }
    spend(w.latencyMs);
    const body = typeof init?.body === 'string' ? init.body : '';
    if (url.startsWith(PROVIDER_B)) {
      const calls = JSON.parse(body) as { id: number; method: string; params: unknown[] }[];
      const isPage = calls.every((c) => c.method === 'eth_call' && (c.params[0] as { to: string }).to.toLowerCase() === MULTICALL3.toLowerCase());
      w.log.push(`${host} ${isPage ? 'page' : 'discovery'}`);
      if (w.providerDown) return new Response('bad gateway', { status: 502 });
      if (isPage) {
        const idx = w.pageRequestIndex++;
        if (w.failPages.has(idx)) return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32011, message: 'requests limited to 25/sec' } }), { status: 200 });
      }
      return Response.json(answerRpc(w, calls, true));
    }
    if (url.startsWith(PUBLIC_RPC)) {
      w.log.push(`${host} rpc`);
      if (w.publicDown) return new Response('down', { status: 503 });
      return Response.json(answerRpc(w, JSON.parse(body), false));
    }
    if (host === 'api.telegram.org') {
      const text = (JSON.parse(body) as { text: string }).text;
      w.log.push(`${host} send`);
      if (w.telegram.mode === 'fail') return new Response('{"ok":false}', { status: 500 });
      if (w.telegram.okMessages !== undefined && w.telegram.sent.length >= w.telegram.okMessages) {
        return new Response('{"ok":false}', { status: 500 });
      }
      if (w.telegram.mode === '429') {
        if (w.telegram.fail429Once) w.telegram.mode = 'ok';
        return new Response(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: w.telegram.retryAfter } }), { status: 429 });
      }
      w.telegram.sent.push(text);
      return Response.json({ ok: true, result: { message_id: w.telegram.sent.length } });
    }
    if (url.startsWith(HC)) {
      w.log.push(`${host} ping`);
      w.hc.pings.push({ url, body });
      const bytes = new TextEncoder().encode(body).length;
      switch (w.hc.mode) {
        case 'ok':
          return new Response('OK', { status: 200, headers: { 'Ping-Body-Limit': '100000' } });
        case 'not_found':
          return new Response('OK (not found)', { status: 200, headers: { 'Ping-Body-Limit': '100000' } });
        case 'rate_limited':
          return new Response('OK (rate limited)', { status: 200, headers: { 'Ping-Body-Limit': '100000' } });
        case 'no_header':
          return new Response('OK', { status: 200 });
        case 'small_header':
          return new Response('OK', { status: 200, headers: { 'Ping-Body-Limit': String(bytes - 1) } });
        case '500':
          return new Response('error', { status: 500 });
        case 'timeout':
          w.clock.t += 10_000;
          throw new DOMException('timed out', 'TimeoutError');
      }
    }
    if (url.startsWith(APP)) {
      const path = new URL(url).pathname;
      w.log.push(`${host} ${path}`);
      if (path === '/api/comments') return w.app.comments ? Response.json({ comments: [], nextCursor: null }) : new Response('err', { status: 500 });
      if (path === '/market/74') {
        return w.app.market
          ? new Response('<html><title>Will ETH close below $1,827 in 3 days? · Mako Market</title></html>')
          : new Response('<html><title>Mako Market</title></html>');
      }
      if (path === '/api/charts') return w.app.charts ? Response.json({ candles: [{ t: 1 }] }) : Response.json({ error: 'upstream_failed' }, { status: 502 });
    }
    throw new Error(`unexpected fetch ${host}`);
  }) as typeof fetch;
}

export function runEnv(): RunEnv {
  return {
    makoAddress: MAKO,
    resolverAddress: RESOLVER,
    publicRpcUrl: PUBLIC_RPC,
    appUrl: APP,
    providerBUrl: PROVIDER_B,
    telegramToken: 'TELEGRAM-TOKEN',
    telegramChatId: '12345',
    healthchecksUrl: HC,
    dryRun: false,
  };
}

export function makeDeps(w: World, state: Deps['state'], logs: string[] = []): Deps {
  return {
    fetch: makeFetch(w),
    now: () => w.clock.t,
    sleep: async (ms) => {
      w.clock.t += ms;
    },
    state,
    env: runEnv(),
    log: (l) => logs.push(l),
  };
}

/// A market that closed `agoS` seconds before `nowS`.
export function closedMarket(mType: number, ref: string, nowS: number, agoS: number, yes: bigint, no: bigint, resolved = false): FakeMarket {
  const closeTime = nowS - agoS;
  return { mType, ref, createdAt: closeTime - 86_400, closeTime, bettingCloseTime: closeTime - 43_200, yes, no, resolved };
}
