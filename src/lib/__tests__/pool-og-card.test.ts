// The pool link preview (/pools/<id>/opengraph-image) draws the share card's design (Joshua 2026-10-26: pool links get
// the new card design) from the pool as read on chain, with a house pool's own side names; an unreadable pool gets the
// brand. The pool sheet shows this same image.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MarketType, Outcome, type MarketWithId } from '../contract';

const U = 1_000_000n;
const NOW = Math.floor(Date.now() / 1000);
const POOL: MarketWithId = {
  id: 158n,
  creator: '0x0c3f00000000000000000000000000000000f6a6',
  mType: MarketType.CRYPTO,
  oracleRef: '0x4554483a67743a32343236000000000000000000000000000000000000000000',
  question: 'Will ETH be above $2,426 at 05:58:16 UTC on Fri 30 Oct?',
  createdAt: BigInt(NOW - 3600),
  bettingCloseTime: BigInt(NOW + 2 * 86400),
  closeTime: BigInt(NOW + 3 * 86400),
  totalYes: 2n * U,
  totalNo: 5n * U,
  yesBettorCount: 2,
  noBettorCount: 1,
  outcome: Outcome.UNRESOLVED,
  resolved: false,
  creatorFeeClaimed: false,
  protocolFeeBpsSnapshot: 100,
  creatorFeeBpsSnapshot: 200,
};

const chain = vi.hoisted(() => ({ market: null as MarketWithId | null }));
const drawn = vi.hoisted(() => ({ calls: [] as { card: { sides: { name: string; pays: string | null }[] }; question: string }[] }));
vi.mock('@/lib/pool-share', () => ({
  poolIdFrom: (s: string) => (/^\d{1,18}$/.test(s) ? BigInt(s) : null),
  readPoolForShare: async () => chain.market,
}));
vi.mock('@/db/client', () => ({ db: {} }));
vi.mock('@/lib/mako-labels-server', () => ({ getMakoLabels: async () => ({ label1: 'Rain', label2: 'Dry' }) }));
vi.mock('@/lib/pool-qr', () => ({ poolQr: async () => 'data:image/svg+xml;base64,' }));
vi.mock('@/lib/pnl-card-image', () => ({
  CARD_SIZE: { width: 1600, height: 900 },
  renderPoolCard: async (card: never, question: string) => {
    drawn.calls.push({ card, question });
    return new Response('png');
  },
}));

const { default: Image } = await import('@/app/pools/[id]/opengraph-image');
const draw = (id: string) => Image({ params: Promise.resolve({ id }) });

beforeEach(() => {
  drawn.calls = [];
});

describe('the pool link preview', () => {
  it('draws the new card from the pool on chain: its question and each side\'s pays', async () => {
    chain.market = POOL;
    await draw('158');
    expect(drawn.calls).toHaveLength(1);
    expect(drawn.calls[0].question).toBe(POOL.question);
    expect(drawn.calls[0].card.sides.map((s) => [s.name, s.pays])).toEqual([
      ['YES', '3.40x'],
      ['NO', '1.36x'],
    ]);
  });

  it('a house pool uses its own side names', async () => {
    chain.market = { ...POOL, mType: MarketType.MAKO };
    await draw('158');
    expect(drawn.calls[0].card.sides.map((s) => s.name)).toEqual(['Rain', 'Dry']);
  });

  it('a pool that cannot be read gets the brand, not a made-up card', async () => {
    chain.market = null;
    const res = await draw('158');
    expect(drawn.calls).toHaveLength(0);
    expect(res.headers.get('content-type')).toBe('image/png');
  });
});
