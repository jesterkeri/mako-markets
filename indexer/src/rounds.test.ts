// The rounds handlers replayed over simulated MakoRoundsV1 events, written from the contract's rules (one stake per
// wallet per round on one side; a tie emits RoundTied then RoundRefunded(Tie); a claim pays stakePart and, to the
// round's creator, creatorFeePart) and from the /stats rules (a person counts once across pools and rounds; Mako
// Market's own wallets never in a public total).

import { describe, it } from 'vitest';
import { createTestIndexer } from 'envio';

import { dayOf, refundReasonOf, roundSideOf } from './totals';

type Address = `0x${string}`;

const CHAIN = 10143;
const ALICE: Address = '0x00000000000000000000000000000000000000a1';
const BOB: Address = '0x00000000000000000000000000000000000000b2';
const CAROL: Address = '0x00000000000000000000000000000000000000c3';
const CREATOR: Address = '0xe490aB83c7f247BEC7d5E04Ce04bc48D6609b550'; // house1, internal
const KEEPER: Address = '0x87ADF596a31D6f30410f174577c1adec4a32319f'; // internal
const DAY1 = 1_791_331_200; // 2026-10-07 00:00 UTC
const USDC = 1_000_000n;
const UP = 1n;
const DOWN = 2n;
const HASH = `0x${'11'.repeat(32)}` as Address;

let block = 69_000_000; // after MakoRoundsV1's start block
const at = (timestamp: number) => ({ block: { number: ++block, timestamp }, transaction: { hash: `0x${block.toString(16).padStart(64, '0')}` as Address } });

const scheduled = (roundId: bigint, timestamp: number, creator: Address = CREATOR) => ({
  contract: 'MakoRoundsV1' as const,
  event: 'RoundScheduled' as const,
  ...at(timestamp),
  params: {
    roundId,
    creator,
    openTime: BigInt(timestamp),
    startTime: BigInt(timestamp + 600),
    entryCloseTime: BigInt(timestamp + 590),
    closeTime: BigInt(timestamp + 1500),
    submitDeadline: BigInt(timestamp + 1500 + 86_400),
  },
});
const entered = (roundId: bigint, entrant: Address, side: bigint, amount: bigint, stakeTotal: bigint, timestamp: number) => ({
  contract: 'MakoRoundsV1' as const,
  event: 'Entered' as const,
  ...at(timestamp),
  params: { roundId, entrant, side, amount, stakeTotal },
});
const fees = (roundId: bigint, total: bigint, protocolFee: bigint, creatorFee: bigint, timestamp: number) => ({
  contract: 'MakoRoundsV1' as const,
  event: 'FeesAccrued' as const,
  ...at(timestamp),
  params: { roundId, total, protocolFee, creatorFee, distributable: total - protocolFee - creatorFee },
});
const evidence = { anchorObservedAt: 0n, closeObservedAt: 0n, anchorReportHash: HASH, closeReportHash: HASH, settler: KEEPER };
const settled = (roundId: bigint, outcome: bigint, anchorPrice: bigint, closePrice: bigint, timestamp: number) => ({
  contract: 'MakoRoundsV1' as const,
  event: 'RoundSettled' as const,
  ...at(timestamp),
  params: { roundId, outcome, anchorPrice, closePrice, ...evidence },
});
const tied = (roundId: bigint, price: bigint, timestamp: number) => ({
  contract: 'MakoRoundsV1' as const,
  event: 'RoundTied' as const,
  ...at(timestamp),
  params: { roundId, anchorPrice: price, closePrice: price, ...evidence },
});
const refunded = (roundId: bigint, reason: bigint, timestamp: number) => ({
  contract: 'MakoRoundsV1' as const,
  event: 'RoundRefunded' as const,
  ...at(timestamp),
  params: { roundId, reason },
});
const claimed = (roundId: bigint, who: Address, stakePart: bigint, creatorFeePart: bigint, timestamp: number) => ({
  contract: 'MakoRoundsV1' as const,
  event: 'Claimed' as const,
  ...at(timestamp),
  params: { roundId, who, stakePart, creatorFeePart },
});
const swept = (roundId: bigint, amount: bigint, timestamp: number) => ({
  contract: 'MakoRoundsV1' as const,
  event: 'RemainderSwept' as const,
  ...at(timestamp),
  params: { roundId, amount },
});
const bet = (id: bigint, user: Address, timestamp: number) => ({
  contract: 'MakoMarketsV4' as const,
  event: 'BetPlaced' as const,
  ...at(timestamp),
  params: { id, user, isYes: true, amount: USDC },
});
const poolCreated = (id: bigint, creator: Address, timestamp: number) => ({
  contract: 'MakoMarketsV4' as const,
  event: 'MarketCreated' as const,
  ...at(timestamp),
  params: { id, creator, mType: 1n, oracleRef: `0x${'00'.repeat(32)}`, closeTime: BigInt(timestamp + 3600), question: `Pool ${id}?` },
});

describe('round lifecycle', () => {
  it('keeps round, entry, wallet, day and global totals in step through an UP win', async (t) => {
    const indexer = createTestIndexer();
    // Alice UP 2 then tops up 1 (stake 3); Bob DOWN 4; Carol UP 1. Pool 8: fees 0.16 protocol + 0.08 creator,
    // distributable 7.76. UP wins: Alice is paid 7.76 * 3/4 = 5.82, Carol 1.94; the creator claims its fee; no remainder.
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            scheduled(1n, DAY1),
            entered(1n, ALICE, UP, 2n * USDC, 2n * USDC, DAY1 + 60),
            entered(1n, ALICE, UP, USDC, 3n * USDC, DAY1 + 120),
            entered(1n, BOB, DOWN, 4n * USDC, 4n * USDC, DAY1 + 180),
            entered(1n, CAROL, UP, USDC, USDC, DAY1 + 240),
            fees(1n, 8n * USDC, 160_000n, 80_000n, DAY1 + 1600),
            settled(1n, UP, 75_000n * 10n ** 18n, 75_100n * 10n ** 18n, DAY1 + 1600),
            claimed(1n, ALICE, 5_820_000n, 0n, DAY1 + 1700),
            claimed(1n, CAROL, 1_940_000n, 0n, DAY1 + 1710),
            claimed(1n, CREATOR, 0n, 80_000n, DAY1 + 1720),
          ],
        },
      },
    });

    t.expect(await indexer.Round.getOrThrow('1')).toMatchObject({
      creator: CREATOR.toLowerCase(),
      startTime: BigInt(DAY1 + 600),
      upPool: 4n * USDC,
      downPool: 4n * USDC,
      upEntrants: 2,
      downEntrants: 1,
      entryCount: 4,
      status: 'Up',
      refundReason: undefined,
      anchorPrice: 75_000n * 10n ** 18n,
      closePrice: 75_100n * 10n ** 18n,
      settledAt: DAY1 + 1600,
      protocolFee: 160_000n,
      creatorFee: 80_000n,
      distributable: 7_760_000n,
      claimedTotal: 7_760_000n,
      remainderSwept: 0n,
    });
    t.expect(await indexer.Wallet.getOrThrow(ALICE)).toMatchObject({
      internal: false,
      roundEntryCount: 2,
      roundsEntered: 1,
      roundStaked: 3n * USDC,
      roundClaimed: 5_820_000n,
      roundCreatorFees: 0n,
      net: 5_820_000n - 3n * USDC,
      betCount: 0,
      firstSeenAt: DAY1 + 60,
    });
    t.expect(await indexer.Wallet.getOrThrow(BOB)).toMatchObject({ roundStaked: 4n * USDC, roundClaimed: 0n, net: -4n * USDC });
    t.expect(await indexer.Wallet.getOrThrow(CREATOR.toLowerCase())).toMatchObject({ internal: true, roundCreatorFees: 80_000n, net: 80_000n });

    t.expect(await indexer.GlobalStats.getOrThrow('global')).toMatchObject({
      wallets: 3,
      bettors: 0,
      internalWallets: 1,
      rounds: 1,
      roundsUp: 1,
      roundsDown: 0,
      roundsRefunded: 0,
      roundEntrants: 3,
      roundEntries: 4,
      roundVolume: 8n * USDC,
      roundClaims: 2,
      roundClaimed: 7_760_000n,
      bets: 0,
      volume: 0n,
    });
    t.expect(await indexer.DailyStats.getOrThrow(dayOf(DAY1).id)).toMatchObject({
      newWallets: 3,
      activeWallets: 3,
      cumulativeWallets: 3,
      roundEntries: 4,
      roundVolume: 8n * USDC,
      bets: 0,
    });
  });
});

describe('a person counts once across pools and rounds', () => {
  it('a pool bettor who then enters a round is one wallet, with one combined net', async (t) => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            poolCreated(9n, BOB, DAY1),
            bet(9n, ALICE, DAY1 + 10),
            scheduled(2n, DAY1 + 20),
            entered(2n, ALICE, DOWN, 2n * USDC, 2n * USDC, DAY1 + 30),
          ],
        },
      },
    });
    t.expect(await indexer.Wallet.getOrThrow(ALICE)).toMatchObject({ betCount: 1, staked: USDC, roundStaked: 2n * USDC, net: -3n * USDC });
    t.expect(await indexer.GlobalStats.getOrThrow('global')).toMatchObject({ wallets: 2, bettors: 1, roundEntrants: 1 });
    t.expect(await indexer.DailyStats.getOrThrow(dayOf(DAY1).id)).toMatchObject({ newWallets: 2, activeWallets: 2, cumulativeWallets: 2 });
  });
});

describe('refunds', () => {
  it('a tie records both prices, ends Refunded/Tie, and counts once', async (t) => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            scheduled(3n, DAY1),
            entered(3n, ALICE, UP, USDC, USDC, DAY1 + 60),
            entered(3n, BOB, DOWN, USDC, USDC, DAY1 + 70),
            tied(3n, 75_000n * 10n ** 18n, DAY1 + 1600),
            refunded(3n, 2n, DAY1 + 1600),
            claimed(3n, ALICE, USDC, 0n, DAY1 + 1700),
          ],
        },
      },
    });
    t.expect(await indexer.Round.getOrThrow('3')).toMatchObject({
      status: 'Refunded',
      refundReason: 'Tie',
      anchorPrice: 75_000n * 10n ** 18n,
      closePrice: 75_000n * 10n ** 18n,
      settledAt: DAY1 + 1600,
      claimedTotal: USDC,
    });
    t.expect(await indexer.GlobalStats.getOrThrow('global')).toMatchObject({
      rounds: 1,
      roundsUp: 0,
      roundsDown: 0,
      roundsRefunded: 1,
      roundsTied: 1,
      roundsOneSided: 0,
      roundsNoPrice: 0,
      roundClaims: 1,
      roundClaimed: USDC,
    });
    t.expect(await indexer.Wallet.getOrThrow(ALICE)).toMatchObject({ roundStaked: USDC, roundClaimed: USDC, net: 0n });
  });

  it('a one-sided round and a no-price round are refunded with their reasons; a repeated refund event counts once', async (t) => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            scheduled(4n, DAY1),
            entered(4n, ALICE, UP, USDC, USDC, DAY1 + 60),
            refunded(4n, 1n, DAY1 + 1600),
            refunded(4n, 1n, DAY1 + 1601),
            scheduled(5n, DAY1 + 3600, '0xf301DdF76efb3F342e8c6b3b9Eb52B6D9851d801'),
            entered(5n, ALICE, UP, USDC, USDC, DAY1 + 3660),
            entered(5n, BOB, DOWN, USDC, USDC, DAY1 + 3670),
            refunded(5n, 3n, DAY1 + 3600 + 1500 + 86_401),
          ],
        },
      },
    });
    t.expect(await indexer.Round.getOrThrow('4')).toMatchObject({ status: 'Refunded', refundReason: 'OneSided', settledAt: DAY1 + 1600, anchorPrice: undefined });
    t.expect(await indexer.Round.getOrThrow('5')).toMatchObject({ status: 'Refunded', refundReason: 'NoPrice', creator: '0xf301ddf76efb3f342e8c6b3b9eb52b6d9851d801' });
    t.expect(await indexer.GlobalStats.getOrThrow('global')).toMatchObject({ rounds: 2, roundsRefunded: 2, roundsOneSided: 1, roundsNoPrice: 1, roundsTied: 0 });
  });
});

describe("Mako Market's own wallets in rounds", () => {
  it('an entry and a claim by an internal wallet are indexed but in no public total', async (t) => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            scheduled(6n, DAY1),
            entered(6n, CREATOR, UP, 5n * USDC, 5n * USDC, DAY1 + 60),
            entered(6n, CAROL, DOWN, USDC, USDC, DAY1 + 70),
            fees(6n, 6n * USDC, 120_000n, 60_000n, DAY1 + 1600),
            settled(6n, UP, 2n, 3n, DAY1 + 1600),
            claimed(6n, CREATOR, 5_820_000n, 60_000n, DAY1 + 1700),
            swept(6n, 1n, DAY1 + 1700),
          ],
        },
      },
    });
    t.expect(await indexer.Round.getOrThrow('6')).toMatchObject({ upPool: 5n * USDC, downPool: USDC, upEntrants: 1, status: 'Up', remainderSwept: 1n, claimedTotal: 5_820_000n });
    t.expect(await indexer.Wallet.getOrThrow(CREATOR.toLowerCase())).toMatchObject({ internal: true, roundStaked: 5n * USDC, roundClaimed: 5_820_000n, roundCreatorFees: 60_000n });
    t.expect(await indexer.GlobalStats.getOrThrow('global')).toMatchObject({
      wallets: 1,
      internalWallets: 1,
      rounds: 1,
      roundsUp: 1,
      roundEntrants: 1,
      roundEntries: 1,
      roundVolume: USDC,
      roundClaims: 0,
      roundClaimed: 0n,
    });
    t.expect(await indexer.DailyStats.getOrThrow(dayOf(DAY1).id)).toMatchObject({ newWallets: 1, activeWallets: 1, roundEntries: 1, roundVolume: USDC });
  });
});

describe('contract values', () => {
  it('maps sides and refund reasons, and refuses values the contract never emits', (t) => {
    t.expect(roundSideOf(1n)).toBe('Up');
    t.expect(roundSideOf(2n)).toBe('Down');
    t.expect(() => roundSideOf(0n)).toThrow();
    t.expect(() => roundSideOf(3n)).toThrow();
    t.expect(refundReasonOf(1n)).toBe('OneSided');
    t.expect(refundReasonOf(2n)).toBe('Tie');
    t.expect(refundReasonOf(3n)).toBe('NoPrice');
    t.expect(() => refundReasonOf(0n)).toThrow();
  });

  it('an entry for a round the index has never seen stops the indexer rather than inventing one', async (t) => {
    const indexer = createTestIndexer();
    await t.expect(indexer.process({ chains: { [CHAIN]: { simulate: [entered(77n, ALICE, UP, USDC, USDC, DAY1)] } } })).rejects.toThrow(/unknown round 77/);
  });
});
