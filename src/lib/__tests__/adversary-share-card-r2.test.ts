// Adversary pass on the share cards (feat/pnl-share-card 3ed996a), spec docs/pnl-share-card/SPEC.md plus the owner
// decisions of 2026-10-23.
//
// Fixture provenance, all read from the public Monad testnet RPC (https://testnet-rpc.monad.xyz/) on 2026-10-23 against
// the live V4 contract 0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195:
//  - pool #138 getMarket at finalized block 73652676: FOREX, totals 1000000 / 1000000, settled YES (outcome 1).
//  - its YES bet: BetPlaced(138, 0x67D6…32A0, true, 1000000), log 5 of tx 0xc9aadd0e…4946, block 71474204.
//  - its NO bet: BetPlaced(138, 0x0C3f…F6A6, false, 1000000), log 4 of tx 0x60e428e4…9900, block 71474367. getMarket
//    at block 71474366 (one block before that bet) reads totals YES 1000000 / NO 0, unresolved.
// The logs are re-encoded with the repo's own ABI (viem encoders) at MAKO_ADDRESS.

import { encodeAbiParameters, encodeEventTopics } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MAKO_ADDRESS, makoAbi, MarketType, Outcome, type MarketWithId } from '../contract';

const U = 1_000_000n;
const YES_TX = '0xc9aadd0eb54e82a93ccb9d7999684adc6546ff1b3689707dfe7604e2b6b74946';
const YES_BETTOR = '0x67D68Eb043f5bCf0898719Ad9a886090148032A0';
const NO_TX = '0x60e428e4b9a15b60267007b22ced0f04174c2c85ac26a2af26bf7c3204cf9900';
const NO_BETTOR = '0x0C3f786653B81FdE81820260C9E1C60dA02CF6A6';

const BASE: MarketWithId = {
  id: 138n,
  creator: YES_BETTOR,
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
const SETTLED_YES: MarketWithId = { ...BASE, outcome: Outcome.YES, resolved: true, creatorFeeClaimed: true };
// Pool #138 as it stood one block before the NO bet landed (block 71474366).
const BEFORE_NO_BET: MarketWithId = { ...BASE, totalNo: 0n, noBettorCount: 0 };

const betLog = (logIndex: number, user: string, isYes: boolean) => ({
  address: MAKO_ADDRESS.toLowerCase(),
  logIndex,
  topics: encodeEventTopics({ abi: makoAbi, eventName: 'BetPlaced', args: { id: 138n, user: user as `0x${string}` } }),
  data: encodeAbiParameters([{ type: 'bool' }, { type: 'uint256' }], [isYes, U]),
});

const chain = vi.hoisted(() => ({
  latest: null as unknown as MarketWithId,
  finalized: null as unknown as MarketWithId,
}));
vi.mock('@/lib/pool-share', () => ({
  poolIdFrom: (s: string) => (/^\d{1,18}$/.test(s) ? BigInt(s) : null),
  // A read pinned to the NO bet's block or later (a bigint, or { blockNumber }) sees the pot holding that bet (#138 at
  // block 71474367 reads 1000000 / 1000000), so a fix that reads at the bet's block is modelled too.
  readPoolForShare: async (_id: bigint, tag: unknown = 'latest', ...rest: unknown[]) => {
    const pinned = [tag, ...rest].map((a) => (typeof a === 'bigint' ? a : (a as { blockNumber?: unknown } | null)?.blockNumber)).find((b) => typeof b === 'bigint');
    if (typeof pinned === 'bigint' && pinned >= 71474367n) return BASE;
    return tag === 'finalized' ? chain.finalized : chain.latest;
  },
  shareClient: () => ({
    getTransactionReceipt: async ({ hash }: { hash: string }) =>
      hash === YES_TX
        ? { status: 'success', blockNumber: 71474204n, logs: [betLog(5, YES_BETTOR, true)] }
        : { status: 'success', blockNumber: 71474367n, logs: [betLog(4, NO_BETTOR, false)] },
    getBlock: async () => ({ timestamp: 1792134800n }),
  }),
}));
vi.mock('@/db/client', () => ({ db: {} }));
const budget = vi.hoisted(() => ({ fetchAllowed: false }));
vi.mock('@/lib/avatar-budget', () => ({
  reserveAvatarVisitor: async () => true,
  reserveAvatarFetch: async () => budget.fetchAllowed,
  visitorIp: () => '203.0.113.7',
}));
// The account has a name and an app-owned photo on its public profile (/u/<address>).
const PHOTO = 'https://storeid.public.blob.vercel-storage.com/avatars/42/photo.png';
vi.mock('@/lib/leaderboard/identity', () => ({
  resolveStoredIdentities: async (_db: unknown, addrs: string[]) => new Map(addrs.map((a) => [a.toLowerCase(), { displayName: 'jester', avatarUrl: PHOTO, branch: 'wallet' }])),
}));
vi.mock('@/lib/leaderboard/profile', () => ({ isRegistered: async () => true }));
vi.mock('@/lib/mako-labels-server', () => ({ getMakoLabels: async () => null }));
vi.mock('@/lib/pool-qr', () => ({ poolQr: async () => 'data:image/svg+xml;base64,' }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
const drawn = vi.hoisted(() => ({ who: [] as { photo: string | null }[] }));
vi.mock('@/lib/pnl-card-image', () => ({
  CARD_SIZE: { width: 1600, height: 900 },
  renderShareCard: async (_card: unknown, who: { photo: string | null }, _qr: unknown, headers: Record<string, string>) => {
    drawn.who.push(who);
    return new Response('png', { headers });
  },
}));

async function image(tx: string, log: string, state: string) {
  const { default: Image } = await import('@/app/pools/[id]/pnl/[tx]/[log]/[state]/opengraph-image');
  return Image({ params: Promise.resolve({ id: '138', tx, log, state }) });
}

beforeEach(() => {
  drawn.who = [];
  budget.fetchAllowed = false;
  vi.unstubAllGlobals();
});

describe('a result card drawn while the photo could not be fetched', () => {
  // Owner decision 2: "Errors that say nothing about the card (rate limit, ...) are never publicly cached."
  // Owner decision 6: the card shows the photo the account's public profile shows.
  it('is not cached for good when the site-wide avatar budget refused the photo', async () => {
    chain.finalized = SETTLED_YES;
    budget.fetchAllowed = false; // the site-wide avatar fetch budget is spent this minute
    const res = await image(YES_TX, '5', 'result');
    const drewWithoutPhoto = res.status === 200 && drawn.who[0]?.photo === null;
    // A letter avatar drawn because of a rate limit must not be pinned in every cache for a year.
    expect(drewWithoutPhoto ? res.headers.get('cache-control') : 'not drawn without the photo').not.toMatch(/immutable|max-age=31536000/);
  });

  it('is not cached for good when the photo fetch timed out', async () => {
    chain.finalized = SETTLED_YES;
    budget.fetchAllowed = true;
    vi.stubGlobal('fetch', async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    const res = await image(YES_TX, '5', 'result');
    const drewWithoutPhoto = res.status === 200 && drawn.who[0]?.photo === null;
    expect(drewWithoutPhoto ? res.headers.get('cache-control') : 'not drawn without the photo').not.toMatch(/immutable|max-age=31536000/);
  });
});

describe('a bet placed card whose pot read does not yet include the bet', () => {
  // Owner decision 3: the estimate is what this bet pays if its side wins "with the pot as it stands now", and "No
  // number may be made up". The receipt (block 71474367) and the latest-block pool read are separate RPC calls; a read
  // answered one block behind the receipt has a NO side of 0, which no pot holding this 1 USDC NO bet can have.
  it('never prints a -100% estimate for a bet that would win 1.94 USDC on the pot that holds it', async () => {
    chain.latest = BEFORE_NO_BET;
    const { loadCard } = await import('@/lib/pnl-card-server');
    const c = await loadCard('138', NO_TX, '4', 'placed', '203.0.113.7');
    const est = c.ok && c.card.variant === 'placed' ? c.card.est : null;
    expect(est ? `${est.payout} ${est.ret.sign}${est.ret.text}` : 'no estimate drawn').not.toBe('0.00 -100%');
  });
});
