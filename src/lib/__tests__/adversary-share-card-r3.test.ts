// Adversary pass r3 on the share cards (feat/pnl-share-card 012bc75, the answer to Codex SHARE_CARDS R1), spec
// docs/pnl-share-card/SPEC.md plus the owner decisions of 2026-10-23:
//  2. "Errors that say nothing about the card are never publicly cached."
//  3. "Each card image has exactly one URL, <card page>/image.png."
//  4. A per-visitor limit plus a site-wide budget before any RPC work.
//
// Fixture provenance, read from the public Monad testnet RPC (https://testnet-rpc.monad.xyz/) on 2026-10-23 against the
// live V4 contract 0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195 (as recorded in adversary-share-card-r2.test.ts):
//  - pool #138: FOREX, totals 1000000 / 1000000, settled YES (outcome 1) at finalized block 73652676; before settlement
//    (after its NO bet in block 71474367) the same totals, unresolved.
//  - its YES bet: BetPlaced(138, 0x67D6…32A0, true, 1000000), log 5 of tx 0xc9aadd0e…4946, block 71474204.
// The log is re-encoded with the repo's own ABI (viem encoders) at MAKO_ADDRESS. The Upstash store is the same
// in-memory stand-in pnl-card-abuse.test.ts uses (the avatar-budget script's INCR, window and cap).

import { encodeAbiParameters, encodeEventTopics, TransactionReceiptNotFoundError } from 'viem';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GET } from '@/app/pools/[id]/pnl/[tx]/[log]/[state]/image.png/route';
import * as page from '@/app/pools/[id]/pnl/[tx]/[log]/[state]/page';
import { proxy } from '@/proxy';

import { MAKO_ADDRESS, makoAbi, MarketType, Outcome, type MarketWithId } from '../contract';

const U = 1_000_000n;
const TX = '0xc9aadd0eb54e82a93ccb9d7999684adc6546ff1b3689707dfe7604e2b6b74946';
const BETTOR = '0x67D68Eb043f5bCf0898719Ad9a886090148032A0';
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
const SETTLED: MarketWithId = { ...OPEN, outcome: Outcome.YES, resolved: true, creatorFeeClaimed: true };

const store = vi.hoisted(() => ({ now: 0, calls: 0, keys: new Map<string, { n: number; until: number }>() }));
vi.mock('@/lib/envio-budget', () => ({
  upstashCommand: async (args: (string | number)[]) => {
    store.calls++;
    const [, , , key, windowMs, cap] = args as [string, string, number, string, number, number];
    const cur = store.keys.get(key);
    const slot = cur && cur.until > store.now ? cur : { n: 0, until: store.now + Number(windowMs) };
    slot.n++;
    store.keys.set(key, slot);
    return slot.n > Number(cap) ? -1 : slot.n;
  },
}));

// The chain. `receiptMisses`: how many receipt reads answer "no receipt" first, as a node a block behind the bet does.
const chain = vi.hoisted(() => ({ pool: null as unknown, receiptMisses: 0, receipts: 0 }));
vi.mock('@/lib/pool-share', () => ({
  poolIdFrom: (s: string) => (/^\d{1,18}$/.test(s) ? BigInt(s) : null),
  readPoolForShare: async () => chain.pool,
  publicShareClient: () => null,
  shareClient: () => ({
    getTransactionReceipt: async ({ hash }: { hash: `0x${string}` }) => {
      chain.receipts++;
      if (hash !== TX || chain.receiptMisses-- > 0) throw new TransactionReceiptNotFoundError({ hash });
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
  }),
}));
vi.mock('@/db/client', () => ({ db: {} }));
vi.mock('next/cache', () => ({ unstable_cache: (fn: () => unknown) => fn }));
vi.mock('@/lib/leaderboard/profile', () => ({ isRegistered: async () => true }));
vi.mock('@/lib/leaderboard/identity', () => ({
  resolveStoredIdentities: async (_db: unknown, addrs: string[]) => new Map(addrs.map((a) => [a, { displayName: 'jester', avatarUrl: null, branch: 'wallet' }])),
}));
vi.mock('@/lib/mako-labels-server', () => ({ getMakoLabels: async () => null }));
vi.mock('@/lib/pool-qr', () => ({ poolQr: async () => 'data:image/svg+xml;base64,' }));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-real-ip': '203.0.113.7' }) }));
vi.mock('@/lib/pnl-card-image', () => ({
  CARD_SIZE: { width: 1600, height: 900 },
  renderShareCard: async (_card: unknown, _who: unknown, _qr: unknown, headers: Record<string, string>) => new Response('png', { headers }),
}));

const isPublic = (r: Response) => /\bpublic\b|s-maxage|max-age=[1-9]/.test(r.headers.get('cache-control') ?? '');

async function image(state: 'placed' | 'result', path = `/pools/138/pnl/${TX}/5/${state}/image.png`) {
  return GET(new Request(`http://localhost${path}`, { headers: { 'x-real-ip': '203.0.113.7' } }), {
    params: Promise.resolve({ id: '138', tx: TX, log: '5', state }),
  });
}

beforeEach(() => {
  store.now = 0;
  store.calls = 0;
  store.keys.clear();
  chain.pool = OPEN;
  chain.receiptMisses = 0;
  chain.receipts = 0;
});

describe('decision 2: an answer that says nothing about the card is never publicly cached', () => {
  // The bet confirmation's Share button opens as soon as the wallet's own RPC returns the receipt (useBetLog). The
  // server reads it again through shareClient, possibly another node, which can be a block behind. That read says
  // nothing about the card (seconds later the same URL is a card), exactly as the pool read a block behind is
  // "unavailable" in loadCard; but a missing receipt at the latest block is turned into a public one-minute 404.
  it('a bet placed image whose receipt the node has not seen yet is not cached as a 404', async () => {
    chain.receiptMisses = 1;
    const first = await image('placed');
    store.now += 1_000;
    const second = await image('placed');
    expect(second.status).toBe(200); // the same URL is a card a moment later
    expect({ status: first.status, publiclyCached: isPublic(first) }).not.toEqual({ status: 404, publiclyCached: true });
  });
});

describe('decision 3: each card image has exactly one URL', () => {
  // Next decodes percent-encoded path segments before matching and hands the route the decoded params (probed on a
  // built 012bc75 with `next start`: /pools/1%338/pnl/<tx>/5/result/image.png and /pools/138/pnl/<tx>/%35/result/
  // image.png reach loadCard's budget, 429 with no store configured, where a non-canonical param is a 404). Each such
  // spelling is a separate URL and CDN key for the same card, drawn and cached a minute.
  it.each([[`/pools/1%338/pnl/${TX}/5/result/image.png`], [`/pools/138/pnl/${TX}/%35/result/image.png`], [`/pools/138/pnl/${TX}/5/resul%74/image.png`]])(
    'refuses %s, a second spelling of the card image URL, before any budget or chain work',
    async (path) => {
      chain.pool = SETTLED;
      const viaProxy = proxy(new NextRequest(`http://localhost${path}`));
      const res = viaProxy.headers.get('x-middleware-next') === '1' ? await image('result', path) : viaProxy;
      expect(res.status).toBe(404);
      expect(store.calls + chain.receipts).toBe(0);
    },
  );
});

describe('decision 4: the budget lets one viewer see one card', () => {
  // A bet placed link shared before settlement, opened after it: the page loads (one reservation), redirects to the
  // result page (a new request, so cache() cannot share: a second), whose <img> asks for the image (a third). With
  // CARD_LOADS_PER_SECOND = 2, a lone viewer whose three requests land in the same second is refused the image.
  it('a lone viewer following a placed link of a settled pool gets the result image', async () => {
    chain.pool = SETTLED;
    const placedPage = await page.default({ params: Promise.resolve({ id: '138', tx: TX, log: '5', state: 'placed' }) }).catch((e: unknown) => e);
    expect(String((placedPage as { digest?: string }).digest)).toContain(`/pools/138/pnl/${TX}/5/result`);
    await page.default({ params: Promise.resolve({ id: '138', tx: TX, log: '5', state: 'result' }) });
    const res = await image('result');
    expect(res.status).toBe(200);
  });
});
