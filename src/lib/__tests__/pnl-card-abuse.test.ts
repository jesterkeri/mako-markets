// The public card endpoints against abuse (Codex SHARE_CARDS R1 F1, F3): every card load reserves from the visitor's
// limit and the site-wide card load budget before its first RPC call, so a flood of made-up but well-formed card URLs
// stops reaching the chain at the cap; and the image is served at one URL only, so a query string (any key, including
// ones Next adds or rewrites) is a 404 before any budget, chain, database or photo work. The real avatar-budget module
// runs against an in-memory stand-in for the Upstash script (same INCR, window and cap). The bet log is pool #138's
// real BetPlaced log re-encoded at the CI contract address (see adversary-pnl-card.test.ts for its provenance).

import { createHash } from 'node:crypto';

import { NextRequest } from 'next/server';
import { encodeAbiParameters, encodeEventTopics, TransactionReceiptNotFoundError } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GET } from '@/app/pools/[id]/pnl/[tx]/[log]/[state]/image.png/route';
import * as page from '@/app/pools/[id]/pnl/[tx]/[log]/[state]/page';
import { AVATAR_VISITOR_PER_MINUTE, CARD_LOAD_WINDOW_MS, CARD_LOADS_PER_WINDOW } from '@/lib/avatar-budget';
import { proxy } from '@/proxy';

import { MAKO_ADDRESS, makoAbi, MarketType, Outcome, type MarketWithId } from '../contract';

const U = 1_000_000n;
const TX = '0xc9aadd0eb54e82a93ccb9d7999684adc6546ff1b3689707dfe7604e2b6b74946';
const BETTOR = '0x67D68Eb043f5bCf0898719Ad9a886090148032A0';
const POOL: MarketWithId = {
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
  outcome: Outcome.YES,
  resolved: true,
  creatorFeeClaimed: true,
  protocolFeeBpsSnapshot: 100,
  creatorFeeBpsSnapshot: 200,
};

// The Upstash store: the avatar-budget script's semantics (count this call in a window that starts on its first call;
// -1 over the cap). `down` makes every call throw, as upstashCommand does when the store cannot be reached.
const store = vi.hoisted(() => ({ now: 0, down: false, calls: 0, keys: new Map<string, { n: number; until: number }>() }));
vi.mock('@/lib/envio-budget', () => ({
  upstashCommand: async (args: (string | number)[]) => {
    store.calls++;
    if (store.down) throw new Error('unreachable');
    const [, , , key, windowMs, cap] = args as [string, string, number, string, number, number];
    const cur = store.keys.get(key);
    const slot = cur && cur.until > store.now ? cur : { n: 0, until: store.now + Number(windowMs) };
    slot.n++;
    store.keys.set(key, slot);
    return slot.n > Number(cap) ? -1 : slot.n;
  },
}));

// The chain: only TX is a real bet; any other hash has no receipt. Plain counters, not vi.fn implementations that throw.
const rpc = vi.hoisted(() => ({ clients: 0, receipts: 0, pools: 0 }));
vi.mock('@/lib/pool-share', () => ({
  poolIdFrom: (s: string) => (/^\d{1,18}$/.test(s) ? BigInt(s) : null),
  readPoolForShare: async () => {
    rpc.pools++;
    return POOL;
  },
  shareClient: () => {
    rpc.clients++;
    return {
      getTransactionReceipt: async ({ hash }: { hash: `0x${string}` }) => {
        rpc.receipts++;
        if (hash !== TX) throw new TransactionReceiptNotFoundError({ hash });
        return {
          status: 'success',
          blockNumber: 71474204n,
          logs: [
            {
              address: MAKO_ADDRESS.toLowerCase(),
              logIndex: 5,
              topics: encodeEventTopics({ abi: makoAbi, eventName: 'BetPlaced', args: { id: 138n, user: BETTOR } }),
              data: encodeAbiParameters([{ type: 'bool' }, { type: 'uint256' }], [true, U]),
            },
          ],
        };
      },
      getBlock: async () => ({ timestamp: 1792134750n }),
    };
  },
}));
vi.mock('@/db/client', () => ({ db: {} }));
const work = vi.hoisted(() => ({ registered: 0, identities: 0, drawn: 0 }));
vi.mock('@/lib/leaderboard/profile', () => ({
  isRegistered: async () => {
    work.registered++;
    return true;
  },
}));
vi.mock('@/lib/leaderboard/identity', () => ({
  resolveStoredIdentities: async (_db: unknown, addrs: string[]) => {
    work.identities++;
    return new Map(addrs.map((a) => [a, { displayName: 'jester', avatarUrl: 'https://storeid.public.blob.vercel-storage.com/avatars/42/photo.png', branch: 'wallet' }]));
  },
}));
vi.mock('@/lib/mako-labels-server', () => ({ getMakoLabels: async () => null }));
vi.mock('@/lib/pool-qr', () => ({ poolQr: async () => 'data:image/svg+xml;base64,' }));
const ip = vi.hoisted(() => ({ value: '203.0.113.7' }));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-real-ip': ip.value }) }));
vi.mock('@/lib/pnl-card-image', () => ({
  CARD_SIZE: { width: 1600, height: 900 },
  renderShareCard: async (_card: unknown, _who: unknown, _qr: unknown, headers: Record<string, string>) => {
    work.drawn++;
    return new Response('png', { headers });
  },
}));

const madeUp = (i: number) => `0x${i.toString(16).padStart(64, 'f')}`;

async function image(tx: string, query = '', from = ip.value) {
  const req = new Request(`http://localhost/pools/138/pnl/${tx}/5/result/image.png${query}`, { headers: { 'x-real-ip': from } });
  return GET(req, { params: Promise.resolve({ id: '138', tx, log: '5', state: 'result' }) });
}

const photoFetch = vi.fn(async () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } }));

beforeEach(() => {
  store.now = 0;
  store.down = false;
  store.calls = 0;
  store.keys.clear();
  rpc.clients = rpc.receipts = rpc.pools = 0;
  work.registered = work.identities = work.drawn = 0;
  ip.value = '203.0.113.7';
  photoFetch.mockClear();
  vi.stubGlobal('fetch', photoFetch);
});

describe('a flood of well-formed, made-up card URLs', () => {
  it('stops reaching the chain at the site-wide cap, from any number of visitors, and the refusals are not cached', async () => {
    const res = [];
    for (let i = 0; i < 50; i++) res.push(await image(madeUp(i), '', `198.51.100.${i}`));
    expect(rpc.receipts).toBe(CARD_LOADS_PER_WINDOW);
    expect(rpc.pools).toBe(CARD_LOADS_PER_WINDOW);
    const refused = res.slice(CARD_LOADS_PER_WINDOW);
    expect(refused.every((r) => r.status === 429 && r.headers.get('cache-control') === 'no-store')).toBe(true);
    // The window passes: the next window has its budget again.
    store.now += CARD_LOAD_WINDOW_MS;
    await image(madeUp(99), '', '198.51.100.99');
    expect(rpc.receipts).toBe(CARD_LOADS_PER_WINDOW + 1);
  });

  it('spends no RPC call for a visitor over its own limit, with site-wide budget to spare', async () => {
    store.keys.set(`mako:avatar:ip:${createHash('sha256').update('192.0.2.1').digest('hex')}`, { n: AVATAR_VISITOR_PER_MINUTE, until: 60_000 });
    const res = await image(madeUp(1), '', '192.0.2.1');
    expect(res.status).toBe(429);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(rpc.clients + rpc.receipts + rpc.pools).toBe(0);
  });

  it('fails closed with the store down: 429, not cached, no RPC call', async () => {
    store.down = true;
    const res = await image(madeUp(1));
    expect(res.status).toBe(429);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(rpc.clients + rpc.receipts + rpc.pools).toBe(0);
  });

  it('the page and its metadata are refused before the chain too', async () => {
    for (let i = 0; i < 10; i++) {
      ip.value = `198.51.100.${i}`;
      const params = Promise.resolve({ id: '138', tx: madeUp(i), log: '5', state: 'result' });
      await page.generateMetadata({ params });
      await page.default({ params }).catch(() => null);
    }
    // vitest has no React request scope, so cache() does not share the load here as it does in the app: each call
    // reserves on its own, and still none past the cap reaches the chain.
    expect(rpc.receipts).toBe(CARD_LOADS_PER_WINDOW);
  });
});

describe('the card image has one URL', () => {
  it('draws the card at the URL the page advertises (openGraph, twitter and the page image are the same)', async () => {
    const meta = await page.generateMetadata({ params: Promise.resolve({ id: '138', tx: TX, log: '5', state: 'result' }) });
    const og = (meta.openGraph?.images as { url: string }[])[0].url;
    expect(meta.twitter?.images).toEqual([og]);
    const url = new URL(og);
    expect(url.pathname).toBe(`/pools/138/pnl/${TX}/5/result/image.png`);
    expect(url.search).toBe('');
    store.keys.clear();
    const res = await image(TX);
    expect(res.status).toBe(200);
    expect(work.drawn).toBe(1);
  });

  it.each([['?x=1'], ['?nxtPv=1'], ['?v=0123456789ab'], ['?_rsc=1a2b3'], ['?3a5c0a4eaf4bb28c'], ['?=']])(
    'refuses %s with a 404 that is not cached, before any budget, chain, database or photo work',
    async (query) => {
      const res = await image(TX, query);
      expect(res.status).toBe(404);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(store.calls).toBe(0);
      expect(rpc.clients + rpc.receipts + rpc.pools).toBe(0);
      expect(work.registered + work.identities + work.drawn).toBe(0);
      expect(photoFetch).not.toHaveBeenCalled();
    },
  );
});

describe('Proxy, which sees the query before Next strips any key', () => {
  const at = (path: string) => {
    return proxy(new NextRequest(`http://localhost${path}`));
  };
  const IMG = `/pools/138/pnl/${TX}/5/result/image.png`;

  it.each([['?x=1'], ['?nxtPv=1'], ['?v=1'], ['?nxtPtx=0xabc'], ['?nxtIfoo=1'], ['?nextInternalLocale=en'], ['?3a5c0a4eaf4bb28c']])(
    'refuses the card image with %s: 404, not cached',
    async (query) => {
      const res = await at(IMG + query);
      expect(res.status).toBe(404);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('x-middleware-next')).toBeNull();
    },
  );

  it('lets the canonical image, and the card page with a query (a tracking tag on a shared link), through', async () => {
    expect((await at(IMG)).headers.get('x-middleware-next')).toBe('1');
    expect((await at(`/pools/138/pnl/${TX}/5/result?utm_source=x`)).headers.get('x-middleware-next')).toBe('1');
  });

  it.each([[`/pools/1%338/pnl/${TX}/5/result`], [`/pools/138/pnl/%30x${TX.slice(2)}/5/placed`], [`/pools/138/pnl/${TX}/5/resul%74/image.png`]])(
    'refuses %s, another spelling of a card URL: 404, not cached',
    async (path) => {
      const res = await at(path);
      expect(res.status).toBe(404);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('x-middleware-next')).toBeNull();
    },
  );
});
