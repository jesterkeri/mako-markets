// Adversary pass on 548dda4 (fix/pool-meta): the pool page's unfurl and the card QR name makomarket.xyz whatever
// NEXT_PUBLIC_APP_URL says, the image is declared at CARD_SIZE, and an unreadable pool keeps its fallback metadata.
// Attacks: the fallback branch, a non-canonical id, a trailing-slash APP_URL, and the QR text itself.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MarketType, Outcome, type MarketWithId } from '../contract';

vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://mako-markets.vercel.app/');

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

let readable = true;
const qrText = vi.fn();
vi.mock('server-only', () => ({}));
vi.mock('qrcode', () => ({ default: { toString: async (text: string) => (qrText(text), '<svg/>') } }));
vi.mock('@/lib/pool-share', async (orig) => ({ ...(await orig<typeof import('../pool-share')>()), readPoolForShare: async () => (readable ? POOL : null) }));
vi.mock('next/navigation', () => ({ notFound: () => {} }));
vi.mock('@/app/pools/[id]/PoolClient', () => ({ PoolClient: () => null }));

const { generateMetadata } = await import('@/app/pools/[id]/page');
const { poolQr } = await import('../pool-qr');

type Og = { url: string; images?: { url: string; width: number; height: number }[] };

describe('adversary 548dda4: pool unfurl origin', () => {
  beforeEach(() => {
    readable = true;
    qrText.mockReset();
  });

  it('a non-canonical id (leading zeros) unfurls at the canonical makomarket.xyz path', async () => {
    const meta = await generateMetadata({ params: Promise.resolve({ id: '0169' }) });
    const og = meta.openGraph as Og;
    expect(og.url).toBe('https://makomarket.xyz/pools/169');
    expect(og.images?.[0]).toMatchObject({ url: 'https://makomarket.xyz/pools/169/opengraph-image', width: 1600, height: 900 });
  });

  it('an unreadable pool keeps its fallback (no explicit image, so the file image applies) on makomarket.xyz', async () => {
    readable = false;
    const meta = await generateMetadata({ params: Promise.resolve({ id: '999999' }) });
    expect(meta.title).toBe('Pool · Mako Market Beta');
    const og = meta.openGraph as Og;
    expect(og.url).toBe('https://makomarket.xyz/pools/999999');
    expect(og).not.toHaveProperty('images');
    expect(meta.twitter).toBeUndefined();
  });

  it('the card QR encodes the makomarket.xyz pool link, never the vercel.app host', async () => {
    await poolQr(169n);
    expect(qrText).toHaveBeenCalledWith('https://makomarket.xyz/pools/169');
  });
});
