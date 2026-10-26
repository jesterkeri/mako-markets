// Share cards read the bet ledger first, and keep a result's final facts on the server (Codex SHARE_CARDS R2 F1, F2;
// owner decisions A and B, 2026-10-24). The ledger is the real mako_market_events table in pglite (migration 0008
// verbatim), so the lookup's filters run as in production. The Upstash budgets are the real avatar-budget module over
// an in-memory stand-in for its script (same INCR, window and cap). Next's data cache is a map that stores JSON, as
// unstable_cache does (a thrown result is never stored). The bet is pool #138's real BetPlaced log (block 71474204,
// tx 0xc9aa…4946, log 5; provenance in adversary-pnl-card.test.ts), recorded at the CI contract address.

import { encodeAbiParameters, encodeEventTopics } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makoMarketEvents } from '@/db/schema';
import { CARD_LOADS_PER_WINDOW, CARD_LOOKUPS_PER_WINDOW, CARD_RENDERS_PER_WINDOW } from '@/lib/avatar-budget';
import { createTestDb, type TestDb } from '@/lib/leaderboard/__tests__/test-db';

import { MAKO_ADDRESS, makoAbi, MarketType, Outcome, type MarketWithId } from '../contract';

const U = 1_000_000n;
const TX = '0xc9aadd0eb54e82a93ccb9d7999684adc6546ff1b3689707dfe7604e2b6b74946';
const BETTOR = '0x67d68eb043f5bcf0898719ad9a886090148032a0';
const OPEN: MarketWithId = {
  id: 138n,
  creator: BETTOR,
  mType: MarketType.FOREX,
  oracleRef: '0x4555525553443a67743a312e3100000000000000000000000000000000000000',
  question: 'Will EURUSD trade above 1.1 in 5 minutes?',
  createdAt: 1792134704n,
  closeTime: 1792135062n,
  bettingCloseTime: 1792134882n,
  totalYes: U,
  totalNo: U,
  yesBettorCount: 1,
  noBettorCount: 1,
  outcome: Outcome.UNRESOLVED,
  resolved: false,
  creatorFeeClaimed: false,
  protocolFeeBpsSnapshot: 100,
  creatorFeeBpsSnapshot: 200,
};
const SETTLED: MarketWithId = { ...OPEN, outcome: Outcome.YES, resolved: true };
const BET_LOG = {
  address: MAKO_ADDRESS.toLowerCase(),
  logIndex: 5,
  topics: encodeEventTopics({ abi: makoAbi, eventName: 'BetPlaced', args: { id: 138n, user: BETTOR } }),
  data: encodeAbiParameters([{ type: 'bool' }, { type: 'uint256' }], [true, U]),
};

const store = vi.hoisted(() => ({ keys: new Map<string, number>() }));
vi.mock('@/lib/envio-budget', () => ({
  upstashCommand: async (args: (string | number)[]) => {
    const [, , , key, , cap] = args as [string, string, number, string, number, number];
    const n = (store.keys.get(key) ?? 0) + 1;
    store.keys.set(key, n);
    return n > Number(cap) ? -1 : n;
  },
}));
const dataCache = vi.hoisted(() => new Map<string, string>());
vi.mock('next/cache', () => ({
  unstable_cache:
    (fn: (...a: unknown[]) => Promise<unknown>, keyParts: string[]) =>
    async (...args: unknown[]) => {
      const k = `${keyParts.join(',')}-${JSON.stringify(args)}`;
      if (dataCache.has(k)) return JSON.parse(dataCache.get(k)!);
      const r = await fn(...args);
      dataCache.set(k, JSON.stringify(r));
      return r;
    },
}));
const chain = vi.hoisted(() => ({ latest: null as unknown, finalized: null as unknown, pools: 0, receipts: 0, blocks: 0 }));
vi.mock('@/lib/pool-share', () => ({
  poolIdFrom: (s: string) => (/^\d{1,18}$/.test(s) ? BigInt(s) : null),
  readPoolForShare: async (_id: bigint, tag: 'latest' | 'finalized' = 'latest') => {
    chain.pools++;
    return tag === 'finalized' ? chain.finalized : chain.latest;
  },
  publicShareClient: () => null,
  shareClient: () => ({
    // The bet's own receipt holds its BetPlaced log at 5; any other hash (made up) has none.
    getTransactionReceipt: async ({ hash }: { hash: string }) => {
      chain.receipts++;
      return { status: 'success', blockNumber: 71474204n, logs: hash === TX ? [BET_LOG] : [] };
    },
    getBlock: async () => {
      chain.blocks++;
      return { timestamp: 0n };
    },
  }),
}));
let t: TestDb;
// Every other database read on this path is mocked below, so each select on db is one ledger lookup.
const dbReads = vi.hoisted(() => ({ n: 0, accounts: 0 }));
vi.mock('@/db/client', () => ({
  get db() {
    return new Proxy(t.db, {
      get: (target, k, r) => (k === 'select' ? (...a: unknown[]) => (dbReads.n++, (target.select as (...x: unknown[]) => unknown)(...a)) : Reflect.get(target, k, r)),
    });
  },
}));
const profile = vi.hoisted(() => ({ displayName: 'jester' as string | null, avatarUrl: 'https://store.public.blob.vercel-storage.com/avatars/42/a.png' as string | null }));
vi.mock('@/lib/leaderboard/profile', () => ({ isRegistered: async () => (dbReads.accounts++, true) }));
vi.mock('@/lib/leaderboard/identity', () => ({
  resolveStoredIdentities: async (_db: unknown, addrs: string[]) => new Map(addrs.map((a) => [a, { displayName: profile.displayName, avatarUrl: profile.avatarUrl }])),
}));
vi.mock('@/lib/mako-labels-server', () => ({ getMakoLabels: async () => null }));
vi.mock('@/lib/pool-qr', () => ({ poolQr: async () => 'data:image/svg+xml;base64,' }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
const drawn = vi.hoisted(() => ({ who: [] as { handle: string; photo: string | null }[] }));
vi.mock('@/lib/pnl-card-image', () => ({
  CARD_SIZE: { width: 1600, height: 900 },
  renderShareCard: async (_card: unknown, who: { handle: string; photo: string | null }, _qr: unknown, headers: Record<string, string>) => {
    drawn.who.push(who);
    return new Response('png', { headers });
  },
}));

const { GET } = await import('@/app/pools/[id]/pnl/[tx]/[log]/[state]/image.png/route');

const image = (tx: string, state: 'placed' | 'result', pool = '138', from = '203.0.113.7') =>
  GET(new Request(`http://localhost/pools/${pool}/pnl/${tx}/5/${state}/image.png`, { headers: { 'x-real-ip': from } }), {
    params: Promise.resolve({ id: pool, tx, log: '5', state }),
  });

beforeEach(async () => {
  t = await createTestDb();
  await t.db.insert(makoMarketEvents).values({
    chainId: 10143,
    contractAddress: MAKO_ADDRESS.toLowerCase(),
    version: 'v4',
    marketId: '138',
    kind: 'bet',
    actor: BETTOR,
    isYes: true,
    amount: U.toString(),
    blockNumber: 71474204,
    blockTimestamp: new Date(1792134750_000),
    txHash: TX,
    logIndex: 5,
  });
  store.keys.clear();
  dataCache.clear();
  Object.assign(chain, { latest: OPEN, finalized: SETTLED, pools: 0, receipts: 0, blocks: 0 });
  drawn.who = [];
  dbReads.n = 0;
  dbReads.accounts = 0;
  profile.displayName = 'jester';
  profile.avatarUrl = 'https://store.public.blob.vercel-storage.com/avatars/42/a.png';
  vi.stubGlobal('fetch', async () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } }));
});
afterEach(async () => {
  await t.close();
});

describe('decision A: the bet ledger first', () => {
  it('made-up hashes past the unknown-bet budget cannot 429 a known bet, whose ledger row saves the block call', async () => {
    for (let i = 0; i < 20; i++) await image(`0x${i.toString(16).padStart(64, 'f')}`, 'placed', '138', `198.51.100.${i}`);
    expect(chain.receipts).toBe(CARD_LOADS_PER_WINDOW);
    const before = { ...chain };
    const res = await image(TX, 'placed');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    // Codex CARD_UNFURL R1 F2: the bet itself is always read from its receipt; the ledger gives the bet time.
    expect([chain.receipts - before.receipts, chain.blocks - before.blocks, chain.pools - before.pools]).toEqual([1, 0, 1]);
    // The same bet under another pool's URL: the ledger row is not this pool's, so the unknown-bet budget pays (spent by
    // the flood above, so refused for now), and once it refills the receipt's bet (pool 138's) makes it final: a 404
    // cached a minute.
    expect((await image(TX, 'placed', '139')).status).toBe(429);
    store.keys.clear();
    const other = await image(TX, 'placed', '139');
    expect([other.status, other.headers.get('cache-control')]).toEqual([404, 'public, max-age=60, s-maxage=60']);
  });
});

describe('Codex CARD_UNFURL R1 F2: the ledger never decides which bet a link names', () => {
  it('a ledger row at the link\'s index whose receipt has no bet there (another node\'s numbering) is no card', async () => {
    await t.db.insert(makoMarketEvents).values({
      chainId: 10143,
      contractAddress: MAKO_ADDRESS.toLowerCase(),
      version: 'v4',
      marketId: '138',
      kind: 'bet',
      actor: BETTOR,
      isYes: true,
      amount: U.toString(),
      blockNumber: 71474204,
      blockTimestamp: new Date(1792134750_000),
      txHash: TX,
      logIndex: 4,
    });
    const res = await GET(new Request(`http://localhost/pools/138/pnl/${TX}/4/placed/image.png`, { headers: { 'x-real-ip': '203.0.113.7' } }), {
      params: Promise.resolve({ id: '138', tx: TX, log: '4', state: 'placed' }),
    });
    expect(res.status).toBe(404);
    expect(drawn.who).toEqual([]);
  });
});

describe('Codex R3 F1: the ledger lookup has its own site-wide budget', () => {
  it('a flood of made-up links from many IPs makes a bounded number of ledger reads, and a kept result card still draws', async () => {
    // A result card opened once: its final facts are kept on the server.
    expect((await image(TX, 'result')).status).toBe(200);
    const kept = dbReads.n;
    for (let i = 0; i < 200; i++) await image(`0x${i.toString(16).padStart(64, 'e')}`, 'placed', '138', `198.51.${i >> 8}.${i & 255}`);
    // Bounded by the lookup budget, though the unknown RPC budget ran out after 6.
    expect(dbReads.n).toBe(CARD_LOOKUPS_PER_WINDOW);
    expect(kept).toBe(1);
    // The kept result card's first load read its receipt once, then the flood's unknown-bet budget.
    expect(chain.receipts).toBe(1 + CARD_LOADS_PER_WINDOW);
    // Owner 2026-10-24: a card nobody opened yet is refused for now, never cached; the kept result makes no read.
    const fresh = await image(TX, 'placed');
    expect([fresh.status, fresh.headers.get('cache-control')]).toEqual([429, 'no-store']);
    const again = await image(TX, 'result');
    expect(again.status).toBe(200);
    expect(dbReads.n).toBe(CARD_LOOKUPS_PER_WINDOW);
  });
});

describe('Codex R3 F1: a real card flooded from many IPs', () => {
  it('makes a bounded number of account reads, then answers 429 never cached', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 60; i++) codes.push((await image(TX, 'result', '138', `192.0.2.${i}`)).status);
    expect(dbReads.accounts).toBe(CARD_RENDERS_PER_WINDOW);
    expect(codes.filter((c) => c === 200)).toHaveLength(CARD_RENDERS_PER_WINDOW);
    expect(codes.filter((c) => c === 429)).toHaveLength(60 - CARD_RENDERS_PER_WINDOW);
    expect((await image(TX, 'result')).headers.get('cache-control')).toBe('no-store');
  });
});

describe('decision B: images are never cached, final facts are kept on the server', () => {
  it('a cached-facts hit makes no RPC call and reserves no budget, and a rename and a photo removal show at once', async () => {
    // Not final yet: thrown, so not kept, and the card draws once the pool settles in a finalized block.
    chain.finalized = OPEN;
    expect((await image(TX, 'result')).headers.get('cache-control')).toBe('no-store');
    chain.finalized = SETTLED;
    const first = await image(TX, 'result');
    const reads = chain.pools + chain.receipts + chain.blocks;
    const budget = store.keys.get('mako:card:known');
    profile.displayName = 'keri';
    profile.avatarUrl = null;
    const next = await image(TX, 'result');
    expect([first.status, next.status]).toEqual([200, 200]);
    expect(chain.pools + chain.receipts + chain.blocks).toBe(reads);
    expect(store.keys.get('mako:card:known')).toBe(budget);
    expect(drawn.who.map((w) => [w.handle, w.photo !== null])).toEqual([
      ['@jester', true],
      ['@keri', false],
    ]);
    expect([first.headers.get('cache-control'), next.headers.get('cache-control')]).toEqual(['no-store', 'no-store']);
  });
});
