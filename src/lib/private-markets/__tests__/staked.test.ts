// ----------------------------------------------------------------------------
// src/lib/private-markets/__tests__/staked.test.ts
//
// Integration tests for processStaked (2B-3): pm_stakes idempotency,
// pool_total atomic increment, first_stake_sequence read-once-and-set,
// orphan-event soft-fail. Driven against the pglite test-db harness so
// the schema's CHECK constraints, partial unique indexes, and
// ON CONFLICT semantics all run.
// ----------------------------------------------------------------------------

import { afterEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';

import { pmMarkets, pmOptions, pmStakes } from '@/db/schema';

import { processStaked, type HandlerCtx } from '../indexer';
import type { DecodedEvent } from '../event-decode';
import { createTestDb, type TestDb } from './test-db';

const CHAIN_ID = 10143;
const CONTRACT = '0xc9c6575a14d0e84afd5ab21c506916fd2864bb8f' as const;
const STAKER_A = '0x1111111111111111111111111111111111111111' as const;
const STAKER_B = '0x2222222222222222222222222222222222222222' as const;
const NONCE_1 =
  '0x0000000000000000000000000000000000000000000000000000000000000001' as const;
const TX_HASH_1 =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
const TX_HASH_2 =
  '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const;

let active: TestDb | null = null;

afterEach(async () => {
  if (active) {
    await active.close();
    active = null;
  }
});

async function setup(): Promise<TestDb> {
  active = await createTestDb();
  return active;
}

async function seedConfirmedFriendly(opts: {
  marketId: number;
}): Promise<string> {
  const inserted = await active!.db
    .insert(pmMarkets)
    .values({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      slug: `dx-${opts.marketId.toString().padStart(8, '0')}`,
      clientNonce: NONCE_1,
      creator: STAKER_A,
      marketId: opts.marketId,
      shape: 'friendly',
      createStatus: 'confirmed',
      confirmedAt: new Date(),
      title: 'A market',
      visibilityView: 0,
      visibilityParticipation: 0,
      stakingOpensAt: new Date('2026-05-12T00:01:00Z'),
      closeAt: new Date('2026-05-12T00:10:00Z'),
    })
    .returning({ id: pmMarkets.id });
  const id = inserted[0].id;
  await active!.db.insert(pmOptions).values([
    {
      marketDbId: id,
      optionIndex: 0,
      label: 'NO',
      participantWallet: null,
      poolTotal: '0',
      firstStakeSequence: null,
    },
    {
      marketDbId: id,
      optionIndex: 1,
      label: 'YES',
      participantWallet: null,
      poolTotal: '0',
      firstStakeSequence: null,
    },
  ]);
  return id;
}

function buildStakedEvent(args: {
  marketId: bigint;
  staker: `0x${string}`;
  optionIndex: bigint;
  amount: bigint;
  timestamp?: bigint;
  txHash?: `0x${string}`;
  logIndex?: number;
}): Extract<DecodedEvent, { eventName: 'Staked' }> {
  return {
    eventName: 'Staked',
    args: {
      marketId: args.marketId,
      staker: args.staker,
      optionIndex: args.optionIndex,
      amount: args.amount,
      timestamp: args.timestamp ?? 1778544100n,
    },
    log: {
      address: CONTRACT,
      blockNumber: 30700100n,
      transactionHash: args.txHash ?? TX_HASH_1,
      logIndex: args.logIndex ?? 0,
    } as unknown as Extract<DecodedEvent, { eventName: 'Staked' }>['log'],
  };
}

async function makeCtx(
  t: TestDb,
  firstStakeSequence?: Map<string, { sequence: number; isSet: boolean }>,
): Promise<HandlerCtx> {
  return {
    chunkTx: t.db as never,
    chainId: CHAIN_ID,
    contractAddress: CONTRACT,
    acquiredLockedAt: new Date(),
    prefetch: new Map(),
    firstStakeSequence,
  };
}

describe('processStaked — pm_stakes insert + pool_total', () => {
  it('inserts pm_stakes row and increments pool_total atomically', async () => {
    const t = await setup();
    await seedConfirmedFriendly({ marketId: 7 });
    const ctx = await makeCtx(t);
    const event = buildStakedEvent({
      marketId: 7n,
      staker: STAKER_A,
      optionIndex: 1n, // YES
      amount: 5_000_000n, // 5 USDC
    });
    const result = await processStaked(ctx, event);
    expect(result.outcome).toBe('inserted');

    const stakes = await t.db.select().from(pmStakes);
    expect(stakes).toHaveLength(1);
    expect(stakes[0].marketId).toBe(7);
    expect(stakes[0].optionIndex).toBe(1);
    expect(stakes[0].amount).toBe('5000000');

    const opts = await t.db
      .select()
      .from(pmOptions)
      .orderBy(pmOptions.optionIndex);
    expect(opts).toHaveLength(2);
    expect(opts[0].poolTotal).toBe('0'); // NO untouched
    expect(opts[1].poolTotal).toBe('5000000'); // YES incremented
  });

  it('replay with same (tx_hash, log_index) is a no-op — pool_total unchanged', async () => {
    const t = await setup();
    await seedConfirmedFriendly({ marketId: 7 });
    const ctx = await makeCtx(t);
    const event = buildStakedEvent({
      marketId: 7n,
      staker: STAKER_A,
      optionIndex: 1n,
      amount: 5_000_000n,
      txHash: TX_HASH_1,
      logIndex: 0,
    });
    const r1 = await processStaked(ctx, event);
    expect(r1.outcome).toBe('inserted');
    const r2 = await processStaked(ctx, event);
    expect(r2.outcome).toBe('replay-noop');

    const stakes = await t.db.select().from(pmStakes);
    expect(stakes).toHaveLength(1); // ON CONFLICT DO NOTHING

    const opts = await t.db
      .select()
      .from(pmOptions)
      .where(eq(pmOptions.optionIndex, 1));
    expect(opts[0].poolTotal).toBe('5000000'); // NOT 10000000
  });

  it('multiple distinct stakes accumulate into pool_total', async () => {
    const t = await setup();
    await seedConfirmedFriendly({ marketId: 7 });
    const ctx = await makeCtx(t);

    await processStaked(
      ctx,
      buildStakedEvent({
        marketId: 7n,
        staker: STAKER_A,
        optionIndex: 1n,
        amount: 1_000_000n,
        txHash: TX_HASH_1,
        logIndex: 0,
      }),
    );
    await processStaked(
      ctx,
      buildStakedEvent({
        marketId: 7n,
        staker: STAKER_B,
        optionIndex: 1n,
        amount: 2_000_000n,
        txHash: TX_HASH_2,
        logIndex: 5,
      }),
    );

    const opts = await t.db
      .select()
      .from(pmOptions)
      .where(eq(pmOptions.optionIndex, 1));
    expect(opts[0].poolTotal).toBe('3000000');
  });

  it('orphan event (no pm_markets row) returns orphan-event with pm_stakes recorded for audit', async () => {
    const t = await setup();
    // No seeding — no pm_markets row exists.
    const ctx = await makeCtx(t);
    const event = buildStakedEvent({
      marketId: 99n,
      staker: STAKER_A,
      optionIndex: 0n,
      amount: 1_000_000n,
    });
    const result = await processStaked(ctx, event);
    expect(result.outcome).toBe('orphan-event');

    const stakes = await t.db.select().from(pmStakes);
    expect(stakes).toHaveLength(1); // Audit trail still recorded.

    // No pm_options to update — and even if there were, the lookup
    // missed so no mirror writes happened.
    const opts = await t.db.select().from(pmOptions);
    expect(opts).toHaveLength(0);
  });
});

describe('processStaked — first_stake_sequence', () => {
  it('writes firstStakeSequence when prefetch isSet=true and DB is NULL', async () => {
    const t = await setup();
    await seedConfirmedFriendly({ marketId: 7 });
    const fss = new Map<string, { sequence: number; isSet: boolean }>([
      ['7:1', { sequence: 42, isSet: true }],
    ]);
    const ctx = await makeCtx(t, fss);
    await processStaked(
      ctx,
      buildStakedEvent({
        marketId: 7n,
        staker: STAKER_A,
        optionIndex: 1n,
        amount: 1_000_000n,
      }),
    );

    const opts = await t.db
      .select()
      .from(pmOptions)
      .where(eq(pmOptions.optionIndex, 1));
    expect(opts[0].firstStakeSequence).toBe(42);
  });

  it('does NOT overwrite firstStakeSequence when DB already has a value (read-once-and-set)', async () => {
    const t = await setup();
    const marketDbId = await seedConfirmedFriendly({ marketId: 7 });
    // Pre-set firstStakeSequence to 10.
    await t.db
      .update(pmOptions)
      .set({ firstStakeSequence: 10 })
      .where(
        and(
          eq(pmOptions.marketDbId, marketDbId),
          eq(pmOptions.optionIndex, 1),
        ),
      );

    const fss = new Map<string, { sequence: number; isSet: boolean }>([
      ['7:1', { sequence: 42, isSet: true }], // would-be-overwrite
    ]);
    const ctx = await makeCtx(t, fss);
    await processStaked(
      ctx,
      buildStakedEvent({
        marketId: 7n,
        staker: STAKER_A,
        optionIndex: 1n,
        amount: 1_000_000n,
      }),
    );

    const opts = await t.db
      .select()
      .from(pmOptions)
      .where(eq(pmOptions.optionIndex, 1));
    expect(opts[0].firstStakeSequence).toBe(10); // NOT 42
  });

  it('does NOT write firstStakeSequence when prefetch isSet=false', async () => {
    const t = await setup();
    await seedConfirmedFriendly({ marketId: 7 });
    const fss = new Map<string, { sequence: number; isSet: boolean }>([
      ['7:1', { sequence: 0, isSet: false }],
    ]);
    const ctx = await makeCtx(t, fss);
    await processStaked(
      ctx,
      buildStakedEvent({
        marketId: 7n,
        staker: STAKER_A,
        optionIndex: 1n,
        amount: 1_000_000n,
      }),
    );

    const opts = await t.db
      .select()
      .from(pmOptions)
      .where(eq(pmOptions.optionIndex, 1));
    expect(opts[0].firstStakeSequence).toBeNull();
  });

  it('omitted firstStakeSequence map (2B-2 callers) leaves the column NULL', async () => {
    const t = await setup();
    await seedConfirmedFriendly({ marketId: 7 });
    const ctx = await makeCtx(t); // no fss map
    await processStaked(
      ctx,
      buildStakedEvent({
        marketId: 7n,
        staker: STAKER_A,
        optionIndex: 1n,
        amount: 1_000_000n,
      }),
    );

    const opts = await t.db
      .select()
      .from(pmOptions)
      .where(eq(pmOptions.optionIndex, 1));
    expect(opts[0].firstStakeSequence).toBeNull();
    // pool_total still updated.
    expect(opts[0].poolTotal).toBe('1000000');
  });
});
