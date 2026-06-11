// ----------------------------------------------------------------------------
// #186 Leaderboard queries — aggregation math on the pglite harness.
//
// Covers: Net PnL math + SQL-side ordering, string-exact transport
// above 2^53 (the Number()-corruption class), creator fees isolated
// from bettor net, refund-nets-zero, the weekly window INCLUDING its
// documented cash-flow distortion (claim-this-week with bet-last-week
// shows stake-less profit — asserted on purpose so the semantics are
// pinned, not accidental), volume ordering for the weekly tab, limit,
// and caller rank.
// ----------------------------------------------------------------------------

import { describe, expect, it, afterEach } from 'vitest';

import {
  getLeaderboardRows,
  getCallerRank,
} from '@/lib/leaderboard/queries';
import { makoMarketEvents, type MakoMarketEventKind } from '@/db/schema';
import { createTestDb, type TestDb } from './test-db';

const CHAIN = 10143;
const CONTRACT = '0x00000000000000000000000000000000000000aa' as const;

const A = '0x000000000000000000000000000000000000a11c' as const;
const B = '0x000000000000000000000000000000000000b22d' as const;
const C = '0x000000000000000000000000000000000000c33e' as const;

let testDb: TestDb | null = null;
let txCounter = 0;

afterEach(async () => {
  if (testDb) {
    await testDb.close();
    testDb = null;
  }
  txCounter = 0;
});

async function freshDb(): Promise<TestDb> {
  testDb = await createTestDb();
  return testDb;
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

async function insertEvent(
  db: TestDb['db'],
  over: {
    actor: string;
    kind: MakoMarketEventKind;
    amount: string;
    blockTimestamp?: Date;
    marketId?: string;
  },
) {
  txCounter += 1;
  await db.insert(makoMarketEvents).values({
    chainId: CHAIN,
    contractAddress: CONTRACT,
    version: 'v4',
    marketId: over.marketId ?? '1',
    kind: over.kind,
    actor: over.actor as `0x${string}`,
    isYes: over.kind === 'bet' ? true : null,
    amount: over.amount,
    blockNumber: 100 + txCounter,
    blockTimestamp: over.blockTimestamp ?? daysAgo(1),
    txHash: `0x${txCounter.toString(16).padStart(64, '0')}` as `0x${string}`,
    logIndex: 0,
  });
}

describe('getLeaderboardRows', () => {
  it('computes staked/won/net per actor and sorts by net in SQL', async () => {
    const { db } = await freshDb();
    await insertEvent(db, { actor: A, kind: 'bet', amount: '10000000' });
    await insertEvent(db, { actor: A, kind: 'claim', amount: '25000000' });
    await insertEvent(db, { actor: B, kind: 'bet', amount: '5000000' });
    await insertEvent(db, { actor: C, kind: 'creator_fee', amount: '1000000' });

    const rows = await getLeaderboardRows(db as never, { window: 'all' });

    expect(rows.map((r) => r.actor)).toEqual([A, C, B]);

    const a = rows[0];
    expect(a.staked).toBe('10000000');
    expect(a.won).toBe('25000000');
    expect(a.net).toBe('15000000');
    expect(a.bets).toBe(1);
    expect(a.creatorFees).toBe('0');

    // Creator fees are the creator's own column, NOT folded into net.
    const c = rows[1];
    expect(c.net).toBe('0');
    expect(c.bets).toBe(0);
    expect(c.creatorFees).toBe('1000000');

    const b = rows[2];
    expect(b.net).toBe('-5000000');
  });

  it('keeps exact precision above 2^53 (strings end-to-end)', async () => {
    const { db } = await freshDb();
    // 2^53 = 9007199254740992; these sums corrupt instantly under
    // Number().
    await insertEvent(db, {
      actor: A,
      kind: 'bet',
      amount: '9007199254740993000000',
    });
    await insertEvent(db, {
      actor: A,
      kind: 'claim',
      amount: '9007199254740993000001',
    });

    const rows = await getLeaderboardRows(db as never, { window: 'all' });
    expect(rows[0].staked).toBe('9007199254740993000000');
    expect(rows[0].won).toBe('9007199254740993000001');
    expect(rows[0].net).toBe('1');
  });

  it('refund claimed in full nets to zero', async () => {
    const { db } = await freshDb();
    await insertEvent(db, { actor: A, kind: 'bet', amount: '5000000' });
    await insertEvent(db, { actor: A, kind: 'claim', amount: '5000000' });

    const rows = await getLeaderboardRows(db as never, { window: 'all' });
    expect(rows[0].net).toBe('0');
  });

  it('weekly window buckets by event timestamp — including the documented cash-flow distortion', async () => {
    const { db } = await freshDb();
    // Bet 8 days ago, claim yesterday: the weekly tab sees stake-less
    // profit. This is the distortion plan open-Q2 names; the SHIPPED
    // decision (Joshua, option a) keeps weekly NET-ranked and explains
    // it with a cash-flow caption in the UI. Pinned here so the
    // semantics never drift silently.
    await insertEvent(db, {
      actor: A,
      kind: 'bet',
      amount: '10000000',
      blockTimestamp: daysAgo(8),
    });
    await insertEvent(db, {
      actor: A,
      kind: 'claim',
      amount: '25000000',
      blockTimestamp: daysAgo(1),
    });

    const weekly = await getLeaderboardRows(db as never, { window: 'week' });
    expect(weekly[0].staked).toBe('0'); // bet fell outside the window
    expect(weekly[0].won).toBe('25000000');
    expect(weekly[0].net).toBe('25000000'); // cash-flow, not performance

    const allTime = await getLeaderboardRows(db as never, { window: 'all' });
    expect(allTime[0].net).toBe('15000000'); // true PnL
  });

  it("orderBy 'staked' ranks by volume regardless of net", async () => {
    const { db } = await freshDb();
    // A: huge winner, tiny volume. B: big volume, net negative.
    await insertEvent(db, { actor: A, kind: 'bet', amount: '1000000' });
    await insertEvent(db, { actor: A, kind: 'claim', amount: '99000000' });
    await insertEvent(db, { actor: B, kind: 'bet', amount: '50000000' });

    const byNet = await getLeaderboardRows(db as never, { window: 'all' });
    expect(byNet[0].actor).toBe(A);

    const byVolume = await getLeaderboardRows(db as never, {
      window: 'all',
      orderBy: 'staked',
    });
    expect(byVolume[0].actor).toBe(B);
  });

  it('respects the limit', async () => {
    const { db } = await freshDb();
    await insertEvent(db, { actor: A, kind: 'bet', amount: '3000000' });
    await insertEvent(db, { actor: B, kind: 'bet', amount: '2000000' });
    await insertEvent(db, { actor: C, kind: 'bet', amount: '1000000' });

    const rows = await getLeaderboardRows(db as never, {
      window: 'all',
      limit: 2,
    });
    expect(rows).toHaveLength(2);
  });
});

describe('getCallerRank', () => {
  it('ranks 1-based by net within the window', async () => {
    const { db } = await freshDb();
    await insertEvent(db, { actor: A, kind: 'bet', amount: '10000000' });
    await insertEvent(db, { actor: A, kind: 'claim', amount: '25000000' });
    await insertEvent(db, { actor: B, kind: 'bet', amount: '5000000' });
    await insertEvent(db, { actor: C, kind: 'creator_fee', amount: '1000000' });

    const a = await getCallerRank(db as never, { window: 'all', address: A });
    const c = await getCallerRank(db as never, { window: 'all', address: C });
    const b = await getCallerRank(db as never, { window: 'all', address: B });
    expect(a?.rank).toBe(1);
    expect(c?.rank).toBe(2);
    expect(b?.rank).toBe(3);
    expect(b?.row.net).toBe('-5000000');
  });

  it('breaks rank ties exactly like the board order (net DESC, actor ASC) — review MINOR-2', async () => {
    const { db } = await freshDb();
    // A and B tie at net −5; C leads at +10. Board ordinals: C #1,
    // A #2 (actor ASC), B #3. Caller rank must match those ordinals.
    await insertEvent(db, { actor: A, kind: 'bet', amount: '5000000' });
    await insertEvent(db, { actor: B, kind: 'bet', amount: '5000000' });
    await insertEvent(db, { actor: C, kind: 'bet', amount: '1000000' });
    await insertEvent(db, { actor: C, kind: 'claim', amount: '11000000' });

    const board = await getLeaderboardRows(db as never, { window: 'all' });
    expect(board.map((r) => r.actor)).toEqual([C, A, B]);

    expect(
      (await getCallerRank(db as never, { window: 'all', address: C }))?.rank,
    ).toBe(1);
    expect(
      (await getCallerRank(db as never, { window: 'all', address: A }))?.rank,
    ).toBe(2);
    expect(
      (await getCallerRank(db as never, { window: 'all', address: B }))?.rank,
    ).toBe(3);
  });

  it('normalizes checksummed input addresses', async () => {
    const { db } = await freshDb();
    const lower = '0xbc5a58487d7949da2b76ac84afc032fd0aa26195';
    const checksummed = '0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195';
    await insertEvent(db, { actor: lower, kind: 'bet', amount: '1000000' });

    const r = await getCallerRank(db as never, {
      window: 'all',
      address: checksummed,
    });
    expect(r).not.toBeNull();
    expect(r!.row.actor).toBe(lower);
  });

  it('returns null for an address with no events in the window', async () => {
    const { db } = await freshDb();
    await insertEvent(db, {
      actor: A,
      kind: 'bet',
      amount: '1000000',
      blockTimestamp: daysAgo(8),
    });

    // Absent entirely.
    expect(
      await getCallerRank(db as never, { window: 'all', address: B }),
    ).toBeNull();
    // Present all-time but outside the weekly window.
    expect(
      await getCallerRank(db as never, { window: 'week', address: A }),
    ).toBeNull();
    expect(
      await getCallerRank(db as never, { window: 'all', address: A }),
    ).not.toBeNull();
  });
});
