// Share cards read the bet ledger first, and keep a result's final facts on the server (Codex SHARE_CARDS R2 F1, F2;
// owner decisions A and B, 2026-10-24). The ledger is the real mako_market_events table in pglite (migration 0008
// verbatim), so the lookup's filters run as in production. The Upstash budgets are the real avatar-budget module over
// an in-memory stand-in for its script (same INCR, window and cap). Next's data cache is a map that stores JSON, as
// unstable_cache does (a thrown result is never stored). The bet is pool #138's real BetPlaced log (block 71474204,
// tx 0xc9aa…4946, log 5; provenance in adversary-pnl-card.test.ts), recorded at the CI contract address.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makoMarketEvents } from '@/db/schema';
import { CARD_LOADS_PER_WINDOW } from '@/lib/avatar-budget';
import { createTestDb, type TestDb } from '@/lib/leaderboard/__tests__/test-db';

import { MAKO_ADDRESS, MarketType, Outcome, type MarketWithId } from '../contract';

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
  shareClient: () => ({
    getTransactionReceipt: async () => {
      chain.receipts++;
      return { status: 'success', blockNumber: 1n, logs: [] };
    },
    getBlock: async () => {
      chain.blocks++;
      return { timestamp: 0n };
    },
  }),
}));
let t: TestDb;
vi.mock('@/db/client', () => ({
  get db() {
    return t.db;
  },
}));
const profile = vi.hoisted(() => ({ displayName: 'jester' as string | null, avatarUrl: 'https://store.public.blob.vercel-storage.com/avatars/42/a.png' as string | null }));
vi.mock('@/lib/leaderboard/profile', () => ({ isRegistered: async () => true }));
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
  profile.displayName = 'jester';
  profile.avatarUrl = 'https://store.public.blob.vercel-storage.com/avatars/42/a.png';
  vi.stubGlobal('fetch', async () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } }));
});
afterEach(async () => {
  await t.close();
});

describe('decision A: the bet ledger first', () => {
  it('a flood of made-up hashes cannot 429 a known bet, which makes no receipt or block call', async () => {
    for (let i = 0; i < 50; i++) await image(`0x${i.toString(16).padStart(64, 'f')}`, 'placed', '138', `198.51.100.${i}`);
    expect(chain.receipts).toBe(CARD_LOADS_PER_WINDOW);
    const before = { ...chain };
    const res = await image(TX, 'placed');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect([chain.receipts - before.receipts, chain.blocks - before.blocks, chain.pools - before.pools]).toEqual([0, 0, 1]);
    // The same bet under another pool's URL is final: a 404 cached a minute.
    const other = await image(TX, 'placed', '139');
    expect([other.status, other.headers.get('cache-control')]).toEqual([404, 'public, max-age=60, s-maxage=60']);
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
