// The card's state is in its URL (/placed or /result), so a cached bet placed card can never stand in for the result,
// and a result card is drawn only from a pool settled in a finalized block. The image route is driven end to end with
// the chain, database and renderer replaced; the bet log is pool #138's real BetPlaced log re-encoded at the CI
// contract address (see adversary-pnl-card.test.ts for its provenance).

import { encodeAbiParameters, encodeEventTopics } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
const SETTLED: MarketWithId = { ...OPEN, outcome: Outcome.YES, resolved: true };
const REFUNDED: MarketWithId = { ...OPEN, outcome: Outcome.REFUND, resolved: true };

const chain = vi.hoisted(() => ({
  latest: null as unknown as MarketWithId,
  finalized: null as unknown as MarketWithId,
  reads: [] as string[],
}));
vi.mock('@/lib/pool-share', () => ({
  poolIdFrom: (s: string) => (/^\d{1,18}$/.test(s) ? BigInt(s) : null),
  readPoolForShare: async (_id: bigint, tag: 'latest' | 'finalized' = 'latest') => {
    chain.reads.push(tag);
    return tag === 'finalized' ? chain.finalized : chain.latest;
  },
  publicShareClient: () => null,
  shareClient: () => ({
    getTransactionReceipt: async () => ({
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
    }),
    getBlock: async () => ({ timestamp: 1792134750n }),
  }),
}));
vi.mock('@/db/client', () => ({ db: {} }));
vi.mock('next/cache', () => ({ unstable_cache: (fn: () => unknown) => fn }));
vi.mock('@/lib/avatar-budget', () => ({ reserveAvatarVisitor: async () => true, reserveCardLoad: async () => true,
  reserveCardLookup: async () => true, reserveCardRender: async () => true, reserveAvatarFetch: async () => false, visitorIp: () => '203.0.113.7' }));
vi.mock('@/lib/leaderboard/identity', () => ({ resolveStoredIdentities: async () => new Map() }));
vi.mock('@/lib/leaderboard/profile', () => ({ isRegistered: async () => true }));
vi.mock('@/lib/mako-labels-server', () => ({ getMakoLabels: async () => null }));
vi.mock('@/lib/pool-qr', () => ({ poolQr: async () => 'data:image/svg+xml;base64,' }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
const drawn = vi.hoisted(() => ({ variants: [] as string[] }));
vi.mock('@/lib/pnl-card-image', () => ({
  CARD_SIZE: { width: 1600, height: 900 },
  renderShareCard: async (card: { variant: string }, _who: unknown, _qr: unknown, headers: Record<string, string>) => {
    drawn.variants.push(card.variant);
    return new Response('png', { headers });
  },
}));

async function image(state: string) {
  const { GET } = await import('@/app/pools/[id]/pnl/[tx]/[log]/[state]/image.png/route');
  return GET(new Request(`http://localhost/pools/138/pnl/${TX}/5/${state}/image.png`), { params: Promise.resolve({ id: '138', tx: TX, log: '5', state }) });
}

beforeEach(() => {
  chain.reads = [];
  drawn.variants = [];
});

describe('a card URL carries its state', () => {
  it('draws the bet placed card for an unsettled pool, never cached (the estimate moves)', async () => {
    chain.latest = OPEN;
    const res = await image('placed');
    expect(res.status).toBe(200);
    expect(drawn.variants).toEqual(['placed']);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(chain.reads).toEqual(['latest']);
  });

  it('a bet placed link whose receipt has no bet at that log is still a 404 cached a minute (the receipt is there)', async () => {
    chain.latest = OPEN;
    const { GET } = await import('@/app/pools/[id]/pnl/[tx]/[log]/[state]/image.png/route');
    const res = await GET(new Request(`http://localhost/pools/138/pnl/${TX}/6/placed/image.png`), { params: Promise.resolve({ id: '138', tx: TX, log: '6', state: 'placed' }) });
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60, s-maxage=60');
    expect(drawn.variants).toEqual([]);
  });

  it('stops drawing the bet placed card once the pool settles, without caching the 404 (latest is not final)', async () => {
    chain.latest = SETTLED;
    const res = await image('placed');
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(drawn.variants).toEqual([]);
  });

  it('draws the result only from the finalized block, never cached (it carries the current name and photo)', async () => {
    chain.latest = SETTLED;
    chain.finalized = SETTLED;
    const res = await image('result');
    expect(res.status).toBe(200);
    expect(drawn.variants).toEqual(['win']);
    expect(chain.reads).toEqual(['finalized']);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('refuses a result settled at the latest block but not yet finalized, without caching the refusal', async () => {
    chain.latest = SETTLED;
    chain.finalized = OPEN;
    const res = await image('result');
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(drawn.variants).toEqual([]);
  });

  it('has no result card for a refunded pool', async () => {
    chain.finalized = REFUNDED;
    expect((await image('result')).status).toBe(404);
  });

  it('sends a bet placed link on to the result once the pool settles', async () => {
    chain.latest = SETTLED;
    const { default: Page } = await import('@/app/pools/[id]/pnl/[tx]/[log]/[state]/page');
    const err = await Page({ params: Promise.resolve({ id: '138', tx: TX, log: '5', state: 'placed' }) }).then(() => null, (e: unknown) => e);
    expect((err as { digest?: string } | null)?.digest).toContain(`/pools/138/pnl/${TX}/5/result`);
  });

  it('a settlement seen only at the latest block and then reorged away: the 404 is not kept, the card draws again', async () => {
    chain.latest = SETTLED;
    const gone = await image('placed');
    expect(gone.status).toBe(404);
    expect(gone.headers.get('cache-control')).toBe('no-store');
    chain.latest = OPEN; // the settling block was reorged out; the pool is open again
    const back = await image('placed');
    expect(back.status).toBe(200);
    expect(back.headers.get('cache-control')).toBe('no-store');
    expect(drawn.variants).toEqual(['placed']);
  });

  it('the page follows the same reorg: on to the result while settled at latest, the card again once open', async () => {
    const { default: Page } = await import('@/app/pools/[id]/pnl/[tx]/[log]/[state]/page');
    const open = () => Page({ params: Promise.resolve({ id: '138', tx: TX, log: '5', state: 'placed' }) });
    chain.latest = SETTLED;
    const err = await open().then(() => null, (e: unknown) => e);
    expect((err as { digest?: string } | null)?.digest).toContain(`/pools/138/pnl/${TX}/5/result`);
    chain.latest = OPEN;
    const page = (await open()) as { props: { children: { props: { src?: string } }[] } };
    expect(page.props.children[0].props.src).toBe(`/pools/138/pnl/${TX}/5/placed/image.png`);
  });

  it('"See the pool" keeps the link’s share tags, for a browser that never runs the forward (Codex CARD_LINKS R1 F1)', async () => {
    const { default: Page } = await import('@/app/pools/[id]/pnl/[tx]/[log]/[state]/page');
    chain.latest = OPEN;
    const searchParams = Promise.resolve({ utm_source: 'x', utm_campaign: 'pool-138', tag: ['a', 'b'], empty: '' });
    const page = (await Page({ params: Promise.resolve({ id: '138', tx: TX, log: '5', state: 'placed' }), searchParams })) as { props: { children: { props: { href?: string } }[] } };
    expect(page.props.children[1].props.href).toBe('/pools/138?utm_source=x&utm_campaign=pool-138&tag=a&tag=b&empty=');
    const bare = (await Page({ params: Promise.resolve({ id: '138', tx: TX, log: '5', state: 'placed' }) })) as typeof page;
    expect(bare.props.children[1].props.href).toBe('/pools/138');
  });

  it('knows no other state', async () => {
    chain.latest = OPEN;
    for (const s of ['win', 'Placed', 'result/', '']) expect((await image(s)).status).toBe(404);
    expect(chain.reads).toEqual([]);
  });
});
