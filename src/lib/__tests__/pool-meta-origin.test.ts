// A pool link's unfurl names makomarket.xyz, never the vercel.app host production sets as NEXT_PUBLIC_APP_URL, and
// declares the preview image's real size (CARD_SIZE, 1600x900).

import { describe, expect, it, vi } from 'vitest';

import { MarketType, Outcome, type MarketWithId } from '../contract';

vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://mako-markets.vercel.app');

const NOW = Math.floor(Date.now() / 1000);
const POOL: MarketWithId = {
  id: 169n,
  creator: '0x0000000000000000000000000000000000000001',
  mType: MarketType.MAKO,
  oracleRef: `0x${'00'.repeat(32)}`,
  question: 'Will the US Fed leave interest rates unchanged on 28 October?',
  createdAt: BigInt(NOW - 600),
  closeTime: BigInt(NOW + 3000),
  bettingCloseTime: BigInt(NOW + 1800),
  totalYes: 0n,
  totalNo: 0n,
  yesBettorCount: 0,
  noBettorCount: 0,
  outcome: Outcome.UNRESOLVED,
  resolved: false,
  creatorFeeClaimed: false,
  protocolFeeBpsSnapshot: 100,
  creatorFeeBpsSnapshot: 200,
};

vi.mock('@/lib/pool-share', async (orig) => ({ ...(await orig<typeof import('../pool-share')>()), readPoolForShare: async () => POOL }));
vi.mock('next/navigation', () => ({ notFound: () => {} }));
vi.mock('@/app/pools/[id]/PoolClient', () => ({ PoolClient: () => null }));

const { generateMetadata } = await import('@/app/pools/[id]/page');
const { CARD_SIZE } = await import('../pnl-card-image');
const { poolUrl } = await import('../pool-share');

describe('pool link unfurl', () => {
  it('names makomarket.xyz for the page, the image and the card QR, whatever NEXT_PUBLIC_APP_URL says', async () => {
    const meta = await generateMetadata({ params: Promise.resolve({ id: '169' }) });
    const og = meta.openGraph as { url: string; images: { url: string; width: number; height: number }[] };
    expect(og.url).toBe('https://makomarket.xyz/pools/169');
    expect(og.images[0].url).toBe('https://makomarket.xyz/pools/169/opengraph-image');
    expect((meta.twitter as { images: string[] }).images).toEqual(['https://makomarket.xyz/pools/169/opengraph-image']);
    expect(poolUrl(169n)).toBe('https://makomarket.xyz/pools/169');
  });

  it('declares the image at its real size', async () => {
    const meta = await generateMetadata({ params: Promise.resolve({ id: '169' }) });
    const img = (meta.openGraph as { images: { width: number; height: number }[] }).images[0];
    expect([img.width, img.height]).toEqual([CARD_SIZE.width, CARD_SIZE.height]);
  });
});
