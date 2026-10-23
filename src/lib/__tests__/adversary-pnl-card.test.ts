// Adversary pass on the PnL share card (feat/pnl-share-card 23befdb), spec docs/pnl-share-card/SPEC.md plus the owner
// decisions of 2026-10-23.
//
// Fixture provenance: pool #138 and its winning bet as read from the public Monad testnet RPC
// (https://testnet-rpc.monad.xyz/) on 2026-10-23. BetPlaced(138, 0x67D6…32A0, true, 1000000) is log index 5 of tx
// 0xc9aadd0e…4946 in block 71474204, emitted by the live V4 contract 0xbC5A…6195. The test runs with the CI job's
// placeholder MAKO_ADDRESS, so the log is re-encoded at that address with the repo's own ABI (viem encoders).

import { encodeAbiParameters, encodeEventTopics, HttpRequestError, TransactionReceiptNotFoundError } from 'viem';
import { describe, expect, it, vi } from 'vitest';

import { MAKO_ADDRESS, makoAbi, MarketType, Outcome, type MarketWithId } from '../contract';
import { betPayout, pnlCard } from '../pnl-card';

const U = 1_000_000n;
const TX = '0xc9aadd0eb54e82a93ccb9d7999684adc6546ff1b3689707dfe7604e2b6b74946';
const BETTOR = '0x67D68Eb043f5bCf0898719Ad9a886090148032A0';

const POOL_138: MarketWithId = {
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

// A plain function, not vi.fn: vitest 2 reports an error thrown inside a vi.fn implementation as a test failure even
// when the code under test catches it.
const chain = vi.hoisted(() => ({ receipt: (async () => null) as () => Promise<unknown> }));
vi.mock('@/lib/pool-share', () => ({
  poolIdFrom: (s: string) => (/^\d{1,18}$/.test(s) ? BigInt(s) : null),
  readPoolForShare: vi.fn(async () => POOL_138),
  shareClient: () => ({ getTransactionReceipt: () => chain.receipt() }),
}));
vi.mock('@/db/client', () => ({ db: {} }));
vi.mock('@/lib/avatar-budget', () => ({
  reserveAvatarVisitor: vi.fn(async () => true),
  reserveCardLoad: vi.fn(async () => true),
  reserveAvatarFetch: vi.fn(async () => false),
  visitorIp: () => '203.0.113.7',
}));
vi.mock('@/lib/leaderboard/identity', () => ({
  resolveStoredIdentities: vi.fn(async () => new Map()),
}));
vi.mock('@/lib/leaderboard/profile', () => ({ isRegistered: vi.fn(async () => false) }));
vi.mock('@/lib/pool-qr', () => ({ poolQr: vi.fn(async () => 'data:image/svg+xml;base64,') }));
vi.mock('@/lib/mako-labels-server', () => ({ getMakoLabels: vi.fn(async () => null) }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));

const betLog = () => ({
  address: MAKO_ADDRESS.toLowerCase(),
  logIndex: 5,
  topics: encodeEventTopics({ abi: makoAbi, eventName: 'BetPlaced', args: { id: 138n, user: BETTOR } }),
  data: encodeAbiParameters([{ type: 'bool' }, { type: 'uint256' }], [true, U]),
});

async function image() {
  const { GET } = await import('@/app/pools/[id]/pnl/[tx]/[log]/[state]/image.png/route');
  return GET(new Request(`http://localhost/pools/138/pnl/${TX}/5/result/image.png`), { params: Promise.resolve({ id: '138', tx: TX, log: '5', state: 'result' }) });
}

describe('card image caching when the chain read fails', () => {
  it('control: a tx the chain does not know is a publicly cached 404 (a made-up URL)', async () => {
    chain.receipt = async () => {
      throw new TransactionReceiptNotFoundError({ hash: TX });
    };
    const res = await image();
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60, s-maxage=60');
  });

  it('a transient RPC failure (429 / -32011) on a real card is never cached publicly as "not a card"', async () => {
    // The RPC refusing the call says nothing about the card; caching it as a 404 at the CDN (s-maxage=60) serves a
    // missing image to every viewer, X's crawler included, for a real bet. opengraph-image.tsx's own rule: a 404 is
    // only for "made-up, refunded, unresolved, not an account's bet"; a refusal about the caller is never cached.
    chain.receipt = async () => {
      throw new HttpRequestError({ url: 'https://testnet-rpc.monad.xyz/', status: 429, details: 'requests limited to 15/sec' });
    };
    const res = await image();
    const cc = res.headers.get('cache-control') ?? '';
    expect(cc).not.toMatch(/public|s-maxage/);
  });

  it('control: the harness reaches the database step for the real log (bettor not registered: 404)', async () => {
    chain.receipt = async () => ({ status: 'success', logs: [betLog()] });
    const { isRegistered } = await import('@/lib/leaderboard/profile');
    const res = await image();
    expect(res.status).toBe(404);
    expect(isRegistered).toHaveBeenCalled();
  });
});

// Parked by the owner (Joshua 2026-10-23): the green win card for a payout below stake stays until users react to it.
describe('variant on a winning side that paid back less than its stake', () => {
  it.skip('a bet that lost money is never drawn as a win ("Called it", rocket, green return)', () => {
    // A house (MAKO) pool: creator fee 0, protocol 1%. 100 USDC on YES, 0.5 USDC on NO, YES won.
    // The pool pays 100.5 x 0.99 = 99.495 USDC for 100 staked: the bet lost 0.505 USDC.
    // SPEC.md "Data": "payout > stake is a win, payout = 0 is a loss"; tokens: the loss line is #E53935, the win
    // return #16A34A. This bet is not a win under that rule.
    const m: MarketWithId = { ...POOL_138, mType: MarketType.MAKO, creatorFeeBpsSnapshot: 0, totalYes: 100n * U, totalNo: U / 2n };
    const bet = { isYes: true, amount: 100n * U };
    const payout = betPayout(m, bet)!;
    expect(payout).toBe(99_495_000n);
    const card = pnlCard(m, bet, { yes: 'YES', no: 'NO' });
    expect(card?.variant).not.toBe('win');
  });
});
