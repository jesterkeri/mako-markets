// The handlers replayed over simulated MakoMarketsV4 events: every running total must match what the events imply.

import { describe, it } from 'vitest';
import { createTestIndexer } from 'envio';

import { categoryOf, dayOf, statusOf } from './totals';

type Address = `0x${string}`;

const CHAIN = 10143;
const ALICE: Address = '0x00000000000000000000000000000000000000a1';
const BOB: Address = '0x00000000000000000000000000000000000000b2';
const CAROL: Address = '0x00000000000000000000000000000000000000c3';
const MAKO: Address = '0xC8BF886f73E4371CBd8160EEA7683b8Da98190F1'; // internal: the contract's owner and resolver
const DAY1 = 1_790_000_000; // 2026-09-21
const DAY2 = DAY1 + 86_400;
const USDC = 1_000_000n;

let block = 33_000_000;
const at = (timestamp: number) => ({ block: { number: ++block, timestamp }, transaction: { hash: `0x${block.toString(16).padStart(64, '0')}` as Address } });

const created = (id: bigint, creator: Address, timestamp: number, mType = 1n) => ({
  contract: 'MakoMarketsV4' as const,
  event: 'MarketCreated' as const,
  ...at(timestamp),
  params: { id, creator, mType, oracleRef: `0x${'00'.repeat(32)}`, closeTime: BigInt(timestamp + 3600), question: `Pool ${id}?` },
});
const bet = (id: bigint, user: Address, isYes: boolean, amount: bigint, timestamp: number) => ({
  contract: 'MakoMarketsV4' as const,
  event: 'BetPlaced' as const,
  ...at(timestamp),
  params: { id, user, isYes, amount },
});
const resolved = (id: bigint, outcome: bigint, timestamp: number) => ({
  contract: 'MakoMarketsV4' as const,
  event: 'MarketResolved' as const,
  ...at(timestamp),
  params: { id, outcome },
});
const claimed = (id: bigint, user: Address, amount: bigint, timestamp: number) => ({
  contract: 'MakoMarketsV4' as const,
  event: 'Claimed' as const,
  ...at(timestamp),
  params: { id, user, amount },
});
const feePaid = (id: bigint, creator: Address, amount: bigint, timestamp: number) => ({
  contract: 'MakoMarketsV4' as const,
  event: 'CreatorFeePaid' as const,
  ...at(timestamp),
  params: { id, creator, amount },
});

describe('pool lifecycle', () => {
  it('keeps pool, wallet, day, category and global totals in step', async (t) => {
    const indexer = createTestIndexer();
    // Alice creates pool 1 with a 2 USDC seed on YES; Bob bets 3 on NO and then 1 more on NO; YES wins;
    // Alice claims 5.82 and her creator fee of 0.12.
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            created(1n, ALICE, DAY1),
            bet(1n, ALICE, true, 2n * USDC, DAY1),
            bet(1n, BOB, false, 3n * USDC, DAY1 + 60),
            bet(1n, BOB, false, 1n * USDC, DAY1 + 120),
            resolved(1n, 1n, DAY1 + 3700),
            claimed(1n, ALICE, 5_820_000n, DAY1 + 3800),
            feePaid(1n, ALICE, 120_000n, DAY1 + 3900),
          ],
        },
      },
    });

    const pool = await indexer.Pool.getOrThrow('1');
    t.expect(pool).toMatchObject({
      creator_id: ALICE,
      category: 'Crypto',
      totalYes: 2n * USDC,
      totalNo: 4n * USDC,
      yesBettors: 1,
      noBettors: 1,
      betCount: 3,
      status: 'Yes',
      resolvedAt: DAY1 + 3700,
      claimedTotal: 5_820_000n,
      creatorFeePaid: 120_000n,
    });

    t.expect(await indexer.Wallet.getOrThrow(ALICE)).toMatchObject({
      internal: false,
      betCount: 1,
      poolsBet: 1,
      poolsCreated: 1,
      staked: 2n * USDC,
      claimed: 5_820_000n,
      creatorFees: 120_000n,
      net: 5_820_000n + 120_000n - 2n * USDC,
      firstSeenAt: DAY1,
    });
    t.expect(await indexer.Wallet.getOrThrow(BOB)).toMatchObject({ betCount: 2, poolsBet: 1, staked: 4n * USDC, net: -4n * USDC });

    t.expect(await indexer.GlobalStats.getOrThrow('global')).toMatchObject({
      wallets: 2,
      bettors: 2,
      bets: 3,
      volume: 6n * USDC,
      pools: 1,
      communityPools: 1,
      poolsSettled: 1,
      poolsRefunded: 0,
      claims: 1,
      claimed: 5_820_000n,
      creatorFeesPaid: 120_000n,
      internalWallets: 0,
    });
    t.expect(await indexer.DailyStats.getOrThrow(dayOf(DAY1).id)).toMatchObject({
      newWallets: 2,
      activeWallets: 2,
      bets: 3,
      volume: 6n * USDC,
      poolsCreated: 1,
      claims: 1,
      cumulativeWallets: 2,
    });
    t.expect(await indexer.CategoryStats.getOrThrow('Crypto')).toMatchObject({ pools: 1, bets: 3, volume: 6n * USDC });
    t.expect(await indexer.Position.getOrThrow(`${BOB}-1`)).toMatchObject({ yes: 0n, no: 4n * USDC, claimed: 0n });
  });
});

describe('bettor counts', () => {
  it('counts a wallet once per side, and again only when it takes the other side', async (t) => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            created(2n, ALICE, DAY1),
            bet(2n, BOB, true, USDC, DAY1),
            bet(2n, BOB, true, USDC, DAY1 + 30),
            bet(2n, BOB, false, USDC, DAY1 + 60),
          ],
        },
      },
    });
    t.expect(await indexer.Pool.getOrThrow('2')).toMatchObject({ yesBettors: 1, noBettors: 1, betCount: 3 });
    t.expect(await indexer.Wallet.getOrThrow(BOB)).toMatchObject({ betCount: 3, poolsBet: 1 });
  });
});

describe("Mako Market's own wallets", () => {
  it('are indexed, but left out of every public count', async (t) => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [created(3n, MAKO, DAY1, 6n), bet(3n, MAKO, true, 5n * USDC, DAY1), bet(3n, CAROL, false, USDC, DAY1 + 10)],
        },
      },
    });
    t.expect(await indexer.Wallet.getOrThrow(MAKO.toLowerCase())).toMatchObject({ internal: true, staked: 5n * USDC, poolsCreated: 1 });
    t.expect(await indexer.Pool.getOrThrow('3')).toMatchObject({ category: 'Mako', totalYes: 5n * USDC, totalNo: USDC });
    t.expect(await indexer.GlobalStats.getOrThrow('global')).toMatchObject({
      wallets: 1,
      bettors: 1,
      internalWallets: 1,
      bets: 1,
      volume: USDC,
      pools: 1,
      communityPools: 0,
    });
    t.expect(await indexer.DailyStats.getOrThrow(dayOf(DAY1).id)).toMatchObject({ newWallets: 1, activeWallets: 1, bets: 1, poolsCreated: 0 });
    t.expect(await indexer.CategoryStats.get('Mako')).toMatchObject({ pools: 0, bets: 1, volume: USDC });
  });
});

describe('days', () => {
  it('names each UTC day, counts a wallet active once a day, and carries the cumulative count', async (t) => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            created(4n, ALICE, DAY1),
            bet(4n, ALICE, true, USDC, DAY1),
            bet(4n, ALICE, true, USDC, DAY1 + 100),
            bet(4n, BOB, false, USDC, DAY2),
            bet(4n, ALICE, false, USDC, DAY2 + 10),
          ],
        },
      },
    });
    t.expect(await indexer.DailyStats.getOrThrow(dayOf(DAY1).id)).toMatchObject({ newWallets: 1, activeWallets: 1, bets: 2, cumulativeWallets: 1 });
    t.expect(await indexer.DailyStats.getOrThrow(dayOf(DAY2).id)).toMatchObject({ newWallets: 1, activeWallets: 2, bets: 2, cumulativeWallets: 2 });
  });
});

describe('refunds', () => {
  it('marks a refunded pool and counts it', async (t) => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: { [CHAIN]: { simulate: [created(5n, ALICE, DAY1), bet(5n, ALICE, true, USDC, DAY1), resolved(5n, 3n, DAY2), claimed(5n, ALICE, USDC, DAY2)] } },
    });
    t.expect(await indexer.Pool.getOrThrow('5')).toMatchObject({ status: 'Refund', claimedTotal: USDC });
    t.expect(await indexer.Wallet.getOrThrow(ALICE)).toMatchObject({ staked: USDC, claimed: USDC, net: 0n });
    t.expect(await indexer.GlobalStats.getOrThrow('global')).toMatchObject({ poolsSettled: 1, poolsRefunded: 1 });
  });
});

describe('contract values', () => {
  it('maps every MarketType and resolved Outcome, and refuses anything else', (t) => {
    t.expect([0n, 1n, 2n, 3n, 4n, 5n, 6n].map(categoryOf)).toEqual(['Football', 'Crypto', 'Basketball', 'Forex', 'Commodities', 'Stocks', 'Mako']);
    t.expect(() => categoryOf(7n)).toThrow();
    t.expect([1n, 2n, 3n].map(statusOf)).toEqual(['Yes', 'No', 'Refund']);
    t.expect(() => statusOf(0n)).toThrow();
    t.expect(dayOf(DAY1)).toEqual({ id: '2026-09-21', start: Math.floor(DAY1 / 86_400) * 86_400 });
  });
});
