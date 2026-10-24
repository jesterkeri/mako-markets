// A result card carries the account's current name and photo (Codex SHARE_CARDS R1 F2): its figures are final once the
// pool settled in a finalized block, but the name and photo are not, so the image is cached a minute at most, like
// /api/avatar's photos, and a rename or a removed photo is what the next render shows. The bet log is pool #138's real
// BetPlaced log re-encoded at the CI contract address (see adversary-pnl-card.test.ts for its provenance).

import { encodeAbiParameters, encodeEventTopics } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GET } from '@/app/pools/[id]/pnl/[tx]/[log]/[state]/image.png/route';

import { MAKO_ADDRESS, makoAbi, MarketType, Outcome, type MarketWithId } from '../contract';

const U = 1_000_000n;
const TX = '0xc9aadd0eb54e82a93ccb9d7999684adc6546ff1b3689707dfe7604e2b6b74946';
const BETTOR = '0x67D68Eb043f5bCf0898719Ad9a886090148032A0';
const SETTLED: MarketWithId = {
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

vi.mock('@/lib/pool-share', () => ({
  poolIdFrom: (s: string) => (/^\d{1,18}$/.test(s) ? BigInt(s) : null),
  readPoolForShare: async () => SETTLED,
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
  }),
}));
vi.mock('@/db/client', () => ({ db: {} }));
vi.mock('next/cache', () => ({ unstable_cache: (fn: () => unknown) => fn }));
vi.mock('@/lib/avatar-budget', () => ({
  reserveAvatarVisitor: async () => true,
  reserveCardLoad: async () => true,
  reserveCardLookup: async () => true, reserveCardRender: async () => true,
  reserveAvatarFetch: async () => true,
  visitorIp: () => '203.0.113.7',
}));
// The account's public profile as it stands at each render.
const PHOTO = 'https://storeid.public.blob.vercel-storage.com/avatars/42/photo.png';
const profile = vi.hoisted(() => ({ displayName: 'jester' as string | null, avatarUrl: null as string | null }));
vi.mock('@/lib/leaderboard/identity', () => ({
  resolveStoredIdentities: async (_db: unknown, addrs: string[]) => new Map(addrs.map((a) => [a, { ...profile, branch: 'wallet' }])),
}));
vi.mock('@/lib/leaderboard/profile', () => ({ isRegistered: async () => true }));
vi.mock('@/lib/mako-labels-server', () => ({ getMakoLabels: async () => null }));
vi.mock('@/lib/pool-qr', () => ({ poolQr: async () => 'data:image/svg+xml;base64,' }));
const drawn = vi.hoisted(() => ({ who: [] as { handle: string; photo: string | null }[] }));
vi.mock('@/lib/pnl-card-image', () => ({
  CARD_SIZE: { width: 1600, height: 900 },
  renderShareCard: async (_card: unknown, who: { handle: string; photo: string | null }, _qr: unknown, headers: Record<string, string>) => {
    drawn.who.push(who);
    return new Response('png', { headers });
  },
}));

function result() {
  return GET(new Request(`http://localhost/pools/138/pnl/${TX}/5/result/image.png`), { params: Promise.resolve({ id: '138', tx: TX, log: '5', state: 'result' }) });
}

const NO_STORE = 'no-store';

beforeEach(() => {
  drawn.who = [];
  profile.displayName = 'jester';
  profile.avatarUrl = PHOTO;
  vi.stubGlobal('fetch', async () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } }));
});

describe('a result card after the account changes its profile', () => {
  it('shows the new name on the next render, and no render is cached at all', async () => {
    const first = await result();
    profile.displayName = 'keri';
    const next = await result();
    expect(drawn.who.map((w) => w.handle)).toEqual(['@jester', '@keri']);
    expect([first.headers.get('cache-control'), next.headers.get('cache-control')]).toEqual([NO_STORE, NO_STORE]);
  });

  it('stops showing a removed photo on the next render: the letter avatar, never cached', async () => {
    const first = await result();
    expect(drawn.who[0].photo).toBe('data:image/png;base64,iVBORw==');
    profile.avatarUrl = null;
    const next = await result();
    expect(drawn.who[1].photo).toBeNull();
    expect([first.headers.get('cache-control'), next.headers.get('cache-control')]).toEqual([NO_STORE, NO_STORE]);
  });
});
