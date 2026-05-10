// ----------------------------------------------------------------------------
// src/lib/private-markets/__tests__/resolutions.test.ts
//
// Phase 2B-4 integration tests for the five resolution-shaped /
// claim handlers:
//   - processResolvedFriendly
//   - processResolvedOpenVote
//   - processDistributedPrizePool
//   - processCanceled
//   - processClaimed
//
// Driven against the pglite test-db harness so JSONB serialization,
// numeric(78,0) precision, and partial-index semantics behave exactly
// as production.
// ----------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

import { pmClaims, pmMarkets, pmOptions, pmResolutions } from '@/db/schema';

import {
  processCanceled,
  processClaimed,
  processDistributedPrizePool,
  processResolvedFriendly,
  processResolvedOpenVote,
  type HandlerCtx,
} from '../indexer';
import type { DecodedEvent } from '../event-decode';
import { createTestDb, type TestDb } from './test-db';

// ---- Fixtures --------------------------------------------------------------

const CHAIN_ID = 10143;
const CONTRACT = '0xc9c6575a14d0e84afd5ab21c506916fd2864bb8f' as const;
const CREATOR = '0x1111111111111111111111111111111111111111' as const;
const STAKER_A = '0x2222222222222222222222222222222222222222' as const;
const STAKER_B = '0x3333333333333333333333333333333333333333' as const;
const NONCE_1 =
  '0x0000000000000000000000000000000000000000000000000000000000000001' as const;
const TX_HASH_1 =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
const TX_HASH_2 =
  '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const;
const BLOCK_HASH_1 =
  '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' as const;
const BLOCK_HASH_2 =
  '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd' as const;
const BLOCK_TS_1 = new Date('2026-05-12T00:30:00Z');
const BLOCK_TS_2 = new Date('2026-05-12T00:31:00Z');

let active: TestDb | null = null;

afterEach(async () => {
  if (active) {
    await active.close();
    active = null;
  }
  vi.restoreAllMocks();
});

async function setup(): Promise<TestDb> {
  active = await createTestDb();
  return active;
}

async function seedConfirmedFriendly(opts: {
  marketId: number;
  currentState?:
    | 'created'
    | 'resolved'
    | 'empty_pool_resolved'
    | 'canceled'
    | 'timed_out'
    | 'zero_stake_expired';
  feeTaken?: string;
}): Promise<string> {
  const inserted = await active!.db
    .insert(pmMarkets)
    .values({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      slug: `dx-${opts.marketId.toString().padStart(8, '0')}`,
      clientNonce: NONCE_1,
      creator: CREATOR,
      marketId: opts.marketId,
      shape: 'friendly',
      createStatus: 'confirmed',
      confirmedAt: new Date(),
      title: 'A market',
      visibilityView: 0,
      visibilityParticipation: 0,
      stakingOpensAt: new Date('2026-05-12T00:01:00Z'),
      closeAt: new Date('2026-05-12T00:10:00Z'),
      currentState: opts.currentState ?? 'created',
      feeTaken: opts.feeTaken ?? '0',
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

async function makeCtx(t: TestDb): Promise<HandlerCtx> {
  return {
    chunkTx: t.db as never,
    chainId: CHAIN_ID,
    contractAddress: CONTRACT,
    acquiredLockedAt: new Date(),
    prefetch: new Map(),
    blockTimestamps: new Map<`0x${string}`, Date>([
      [BLOCK_HASH_1, BLOCK_TS_1],
      [BLOCK_HASH_2, BLOCK_TS_2],
    ]),
  };
}

interface SyntheticLog {
  address: `0x${string}`;
  blockNumber: bigint;
  transactionHash: `0x${string}`;
  logIndex: number;
  blockHash: `0x${string}`;
}

function buildLog(
  txHash: `0x${string}` = TX_HASH_1,
  logIndex = 0,
  blockHash: `0x${string}` = BLOCK_HASH_1,
): SyntheticLog {
  return {
    address: CONTRACT,
    blockNumber: 30700100n,
    transactionHash: txHash,
    logIndex,
    blockHash,
  };
}

function buildResolvedFriendlyEvent(args: {
  marketId: bigint;
  outcome: number;
  emptyPoolPath: boolean;
  feeTaken: bigint;
  totalOwed: bigint;
  txHash?: `0x${string}`;
  logIndex?: number;
}): Extract<DecodedEvent, { eventName: 'ResolvedFriendly' }> {
  return {
    eventName: 'ResolvedFriendly',
    args: {
      marketId: args.marketId,
      outcome: args.outcome,
      emptyPoolPath: args.emptyPoolPath,
      feeTaken: args.feeTaken,
      totalOwed: args.totalOwed,
    },
    log: buildLog(
      args.txHash,
      args.logIndex,
    ) as unknown as Extract<DecodedEvent, { eventName: 'ResolvedFriendly' }>['log'],
  };
}

function buildResolvedOpenVoteEvent(args: {
  marketId: bigint;
  topN: readonly bigint[];
  feeTaken: bigint;
  txHash?: `0x${string}`;
  logIndex?: number;
}): Extract<DecodedEvent, { eventName: 'ResolvedOpenVote' }> {
  return {
    eventName: 'ResolvedOpenVote',
    args: {
      marketId: args.marketId,
      topN: args.topN,
      feeTaken: args.feeTaken,
    },
    log: buildLog(
      args.txHash,
      args.logIndex,
    ) as unknown as Extract<DecodedEvent, { eventName: 'ResolvedOpenVote' }>['log'],
  };
}

function buildDistributedPrizePoolEvent(args: {
  marketId: bigint;
  topN: readonly bigint[];
  winnerWallets: readonly `0x${string}`[];
  amountsOwed: readonly bigint[];
  feeTaken: bigint;
  txHash?: `0x${string}`;
  logIndex?: number;
}): Extract<DecodedEvent, { eventName: 'DistributedPrizePool' }> {
  return {
    eventName: 'DistributedPrizePool',
    args: {
      marketId: args.marketId,
      topN: args.topN,
      winnerWallets: args.winnerWallets,
      amountsOwed: args.amountsOwed,
      feeTaken: args.feeTaken,
    },
    log: buildLog(
      args.txHash,
      args.logIndex,
    ) as unknown as Extract<DecodedEvent, { eventName: 'DistributedPrizePool' }>['log'],
  };
}

function buildCanceledEvent(args: {
  marketId: bigint;
  reason: number;
  txHash?: `0x${string}`;
  logIndex?: number;
}): Extract<DecodedEvent, { eventName: 'Canceled' }> {
  return {
    eventName: 'Canceled',
    args: { marketId: args.marketId, reason: args.reason },
    log: buildLog(
      args.txHash,
      args.logIndex,
    ) as unknown as Extract<DecodedEvent, { eventName: 'Canceled' }>['log'],
  };
}

function buildClaimedEvent(args: {
  marketId: bigint;
  recipient: `0x${string}`;
  amount: bigint;
  txHash?: `0x${string}`;
  logIndex?: number;
  blockHash?: `0x${string}`;
}): Extract<DecodedEvent, { eventName: 'Claimed' }> {
  return {
    eventName: 'Claimed',
    args: {
      marketId: args.marketId,
      recipient: args.recipient,
      amount: args.amount,
    },
    log: buildLog(
      args.txHash,
      args.logIndex,
      args.blockHash,
    ) as unknown as Extract<DecodedEvent, { eventName: 'Claimed' }>['log'],
  };
}

// ---------------------------------------------------------------------------
// processResolvedFriendly
// ---------------------------------------------------------------------------

describe('processResolvedFriendly', () => {
  it('paid path: created → resolved; mirrors outcome, emptyPoolPath=false, feeTaken', async () => {
    const t = await setup();
    await seedConfirmedFriendly({ marketId: 7 });
    const ctx = await makeCtx(t);
    const event = buildResolvedFriendlyEvent({
      marketId: 7n,
      outcome: 1, // YES
      emptyPoolPath: false,
      feeTaken: 250_000n,
      totalOwed: 9_750_000n,
    });
    const r = await processResolvedFriendly(ctx, event);
    expect(r.outcome).toBe('resolved');

    const m = await t.db.select().from(pmMarkets);
    expect(m).toHaveLength(1);
    expect(m[0].currentState).toBe('resolved');
    expect(m[0].friendlyOutcome).toBe(1);
    expect(m[0].friendlyEmptyPoolPath).toBe(false);
    // Codex r3 m2: numeric column stored as exact decimal string
    expect(m[0].feeTaken).toBe('250000');

    const res = await t.db.select().from(pmResolutions);
    expect(res).toHaveLength(1);
    expect(res[0].eventName).toBe('ResolvedFriendly');
    expect(res[0].marketId).toBe(7);
    const payload = res[0].payload as {
      outcome: number;
      emptyPoolPath: boolean;
      feeTaken: string;
      totalOwed: string;
    };
    expect(payload.outcome).toBe(1);
    expect(payload.emptyPoolPath).toBe(false);
    expect(payload.feeTaken).toBe('250000');
    expect(payload.totalOwed).toBe('9750000');
  });

  it('empty-pool path: created → empty_pool_resolved; emptyPoolPath=true; feeTaken=0', async () => {
    const t = await setup();
    await seedConfirmedFriendly({ marketId: 8 });
    const ctx = await makeCtx(t);
    const event = buildResolvedFriendlyEvent({
      marketId: 8n,
      outcome: 0, // NO
      emptyPoolPath: true,
      feeTaken: 0n,
      totalOwed: 0n,
    });
    const r = await processResolvedFriendly(ctx, event);
    expect(r.outcome).toBe('empty-pool-resolved');

    const m = await t.db
      .select()
      .from(pmMarkets)
      .where(eq(pmMarkets.marketId, 8));
    expect(m[0].currentState).toBe('empty_pool_resolved');
    expect(m[0].friendlyEmptyPoolPath).toBe(true);
    expect(m[0].feeTaken).toBe('0');
  });

  it('idempotency: replay → replay-noop; pm_resolutions count unchanged; pm_markets unchanged', async () => {
    const t = await setup();
    await seedConfirmedFriendly({ marketId: 9 });
    const ctx = await makeCtx(t);
    const event = buildResolvedFriendlyEvent({
      marketId: 9n,
      outcome: 1,
      emptyPoolPath: false,
      feeTaken: 100_000n,
      totalOwed: 3_900_000n,
    });
    const r1 = await processResolvedFriendly(ctx, event);
    expect(r1.outcome).toBe('resolved');
    const r2 = await processResolvedFriendly(ctx, event);
    expect(r2.outcome).toBe('replay-noop');

    const res = await t.db.select().from(pmResolutions);
    expect(res).toHaveLength(1);
  });

  it('orphan: pm_markets row absent → orphan-event; pm_resolutions inserted; warn logged', async () => {
    const t = await setup();
    const ctx = await makeCtx(t);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const event = buildResolvedFriendlyEvent({
      marketId: 999n,
      outcome: 1,
      emptyPoolPath: false,
      feeTaken: 100n,
      totalOwed: 0n,
    });
    const r = await processResolvedFriendly(ctx, event);
    expect(r.outcome).toBe('orphan-event');

    const res = await t.db.select().from(pmResolutions);
    expect(res).toHaveLength(1);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('state-mismatch: pm_markets is canceled → state-mismatch; mirror skipped (Codex r1 M2)', async () => {
    const t = await setup();
    await seedConfirmedFriendly({
      marketId: 10,
      currentState: 'canceled',
    });
    const ctx = await makeCtx(t);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const event = buildResolvedFriendlyEvent({
      marketId: 10n,
      outcome: 1,
      emptyPoolPath: false,
      feeTaken: 100n,
      totalOwed: 0n,
    });
    const r = await processResolvedFriendly(ctx, event);
    expect(r.outcome).toBe('state-mismatch');

    const res = await t.db.select().from(pmResolutions);
    expect(res).toHaveLength(1);

    const m = await t.db
      .select()
      .from(pmMarkets)
      .where(eq(pmMarkets.marketId, 10));
    expect(m[0].currentState).toBe('canceled'); // unchanged
    expect(m[0].friendlyOutcome).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// processResolvedOpenVote
// ---------------------------------------------------------------------------

describe('processResolvedOpenVote', () => {
  it('happy path: created → resolved; topN stored as number[]; feeTaken mirrored', async () => {
    const t = await setup();
    await seedConfirmedFriendly({ marketId: 11 });
    const ctx = await makeCtx(t);
    const event = buildResolvedOpenVoteEvent({
      marketId: 11n,
      topN: [1n, 0n],
      feeTaken: 500_000n,
    });
    const r = await processResolvedOpenVote(ctx, event);
    expect(r.outcome).toBe('resolved');

    const m = await t.db
      .select()
      .from(pmMarkets)
      .where(eq(pmMarkets.marketId, 11));
    expect(m[0].currentState).toBe('resolved');
    expect(m[0].feeTaken).toBe('500000');

    const res = await t.db.select().from(pmResolutions);
    expect(res).toHaveLength(1);
    const payload = res[0].payload as {
      topN: number[];
      feeTaken: string;
    };
    expect(payload.topN).toEqual([1, 0]); // numbers, not bigints
    expect(payload.feeTaken).toBe('500000');
  });

  it('idempotency: replay → replay-noop', async () => {
    const t = await setup();
    await seedConfirmedFriendly({ marketId: 12 });
    const ctx = await makeCtx(t);
    const event = buildResolvedOpenVoteEvent({
      marketId: 12n,
      topN: [0n, 1n],
      feeTaken: 100n,
    });
    await processResolvedOpenVote(ctx, event);
    const r2 = await processResolvedOpenVote(ctx, event);
    expect(r2.outcome).toBe('replay-noop');
  });

  it('state-mismatch: pre-canceled row → state-mismatch; mirror skipped', async () => {
    const t = await setup();
    await seedConfirmedFriendly({
      marketId: 13,
      currentState: 'canceled',
    });
    const ctx = await makeCtx(t);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const event = buildResolvedOpenVoteEvent({
      marketId: 13n,
      topN: [1n],
      feeTaken: 100n,
    });
    const r = await processResolvedOpenVote(ctx, event);
    expect(r.outcome).toBe('state-mismatch');
    const m = await t.db
      .select()
      .from(pmMarkets)
      .where(eq(pmMarkets.marketId, 13));
    expect(m[0].currentState).toBe('canceled');
  });
});

// ---------------------------------------------------------------------------
// processDistributedPrizePool
// ---------------------------------------------------------------------------

describe('processDistributedPrizePool', () => {
  it('happy path: created → resolved; payload contains lowercased winners + string amounts', async () => {
    const t = await setup();
    await seedConfirmedFriendly({ marketId: 14 });
    const ctx = await makeCtx(t);
    // Mixed-case winner addresses to verify lowercase normalisation.
    const winnerMixed =
      '0xAbCdAbCdAbCdAbCdAbCdAbCdAbCdAbCdAbCdAbCd' as `0x${string}`;
    const event = buildDistributedPrizePoolEvent({
      marketId: 14n,
      topN: [1n, 0n],
      winnerWallets: [winnerMixed, STAKER_A],
      amountsOwed: [
        7_000_000_000_000_000_000n,
        3_000_000_000_000_000_000n,
      ],
      feeTaken: 1_000_000_000_000_000_000n,
    });
    const r = await processDistributedPrizePool(ctx, event);
    expect(r.outcome).toBe('resolved');

    const m = await t.db
      .select()
      .from(pmMarkets)
      .where(eq(pmMarkets.marketId, 14));
    expect(m[0].currentState).toBe('resolved');
    expect(m[0].feeTaken).toBe('1000000000000000000');

    const res = await t.db.select().from(pmResolutions);
    expect(res).toHaveLength(1);
    const payload = res[0].payload as {
      topN: number[];
      winnerWallets: string[];
      amountsOwed: string[];
      feeTaken: string;
    };
    expect(payload.topN).toEqual([1, 0]);
    expect(payload.winnerWallets[0]).toBe(winnerMixed.toLowerCase());
    expect(payload.winnerWallets[1]).toBe(STAKER_A);
    expect(payload.amountsOwed).toEqual([
      '7000000000000000000',
      '3000000000000000000',
    ]);
    expect(payload.feeTaken).toBe('1000000000000000000');
  });

  it('state-mismatch: pre-resolved row → state-mismatch', async () => {
    const t = await setup();
    await seedConfirmedFriendly({
      marketId: 15,
      currentState: 'resolved',
    });
    const ctx = await makeCtx(t);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const event = buildDistributedPrizePoolEvent({
      marketId: 15n,
      topN: [1n],
      winnerWallets: [STAKER_A],
      amountsOwed: [100n],
      feeTaken: 1n,
    });
    const r = await processDistributedPrizePool(ctx, event);
    expect(r.outcome).toBe('state-mismatch');
  });
});

// ---------------------------------------------------------------------------
// processCanceled
// ---------------------------------------------------------------------------

describe('processCanceled', () => {
  it('reason 0 (creator-canceled) → current_state=canceled; fee_taken=0', async () => {
    const t = await setup();
    // Seed with fee_taken=999 to verify the explicit reset (Codex r1 m1).
    // (On-chain this can't happen, but defensive against any future write
    // path that mutates fee_taken before Canceled lands.)
    await seedConfirmedFriendly({ marketId: 20, feeTaken: '999' });
    const ctx = await makeCtx(t);
    const event = buildCanceledEvent({ marketId: 20n, reason: 0 });
    const r = await processCanceled(ctx, event);
    expect(r.outcome).toBe('canceled');

    const m = await t.db
      .select()
      .from(pmMarkets)
      .where(eq(pmMarkets.marketId, 20));
    expect(m[0].currentState).toBe('canceled');
    expect(m[0].feeTaken).toBe('0');
  });

  it('reason 1 (timed-out) → current_state=timed_out', async () => {
    const t = await setup();
    await seedConfirmedFriendly({ marketId: 21 });
    const ctx = await makeCtx(t);
    const event = buildCanceledEvent({ marketId: 21n, reason: 1 });
    const r = await processCanceled(ctx, event);
    expect(r.outcome).toBe('timed-out');
    const m = await t.db
      .select()
      .from(pmMarkets)
      .where(eq(pmMarkets.marketId, 21));
    expect(m[0].currentState).toBe('timed_out');
  });

  it('reason 2 (zero-stake-expired) → current_state=zero_stake_expired', async () => {
    const t = await setup();
    await seedConfirmedFriendly({ marketId: 22 });
    const ctx = await makeCtx(t);
    const event = buildCanceledEvent({ marketId: 22n, reason: 2 });
    const r = await processCanceled(ctx, event);
    expect(r.outcome).toBe('zero-stake-expired');
    const m = await t.db
      .select()
      .from(pmMarkets)
      .where(eq(pmMarkets.marketId, 22));
    expect(m[0].currentState).toBe('zero_stake_expired');
  });

  it('reason 99 (unknown, first-seen) → unknown-reason; pm_resolutions inserted; pm_markets unchanged', async () => {
    const t = await setup();
    await seedConfirmedFriendly({ marketId: 23 });
    const ctx = await makeCtx(t);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const event = buildCanceledEvent({ marketId: 23n, reason: 99 });
    const r = await processCanceled(ctx, event);
    expect(r.outcome).toBe('unknown-reason');

    const res = await t.db.select().from(pmResolutions);
    expect(res).toHaveLength(1);
    expect(res[0].eventName).toBe('Canceled');
    const payload = res[0].payload as { reason: number };
    expect(payload.reason).toBe(99);

    const m = await t.db
      .select()
      .from(pmMarkets)
      .where(eq(pmMarkets.marketId, 23));
    expect(m[0].currentState).toBe('created'); // unchanged
    expect(warn).toHaveBeenCalledOnce();
  });

  it('reason 99 replay → replay-noop, NOT unknown-reason (Codex r1 m2)', async () => {
    const t = await setup();
    await seedConfirmedFriendly({ marketId: 24 });
    const ctx = await makeCtx(t);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const event = buildCanceledEvent({ marketId: 24n, reason: 99 });
    const r1 = await processCanceled(ctx, event);
    expect(r1.outcome).toBe('unknown-reason');
    const r2 = await processCanceled(ctx, event);
    expect(r2.outcome).toBe('replay-noop');

    const res = await t.db.select().from(pmResolutions);
    expect(res).toHaveLength(1);
    // Warn fires exactly once (first call), not twice.
    expect(warn).toHaveBeenCalledOnce();
  });

  it('reason 99 + orphan precedence (Codex r2 m2): orphan-event > unknown-reason', async () => {
    const t = await setup();
    const ctx = await makeCtx(t);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // No pm_markets row seeded.
    const event = buildCanceledEvent({ marketId: 999n, reason: 99 });
    const r = await processCanceled(ctx, event);
    expect(r.outcome).toBe('orphan-event');

    const res = await t.db.select().from(pmResolutions);
    expect(res).toHaveLength(1);
  });

  it('state-mismatch: pre-resolved row + reason 0 → state-mismatch', async () => {
    const t = await setup();
    await seedConfirmedFriendly({
      marketId: 26,
      currentState: 'resolved',
    });
    const ctx = await makeCtx(t);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const event = buildCanceledEvent({ marketId: 26n, reason: 0 });
    const r = await processCanceled(ctx, event);
    expect(r.outcome).toBe('state-mismatch');
    const m = await t.db
      .select()
      .from(pmMarkets)
      .where(eq(pmMarkets.marketId, 26));
    expect(m[0].currentState).toBe('resolved'); // unchanged
  });
});

// ---------------------------------------------------------------------------
// processClaimed
// ---------------------------------------------------------------------------

describe('processClaimed', () => {
  it('happy path: pm_claims row inserted with lowercased recipient + string amount + cached block_timestamp', async () => {
    const t = await setup();
    await seedConfirmedFriendly({ marketId: 30 });
    const ctx = await makeCtx(t);
    const recipientMixed =
      '0xDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEf' as `0x${string}`;
    const event = buildClaimedEvent({
      marketId: 30n,
      recipient: recipientMixed,
      amount: 12_345n,
    });
    const r = await processClaimed(ctx, event);
    expect(r.outcome).toBe('inserted');

    const claims = await t.db.select().from(pmClaims);
    expect(claims).toHaveLength(1);
    expect(claims[0].marketId).toBe(30);
    expect(claims[0].recipient).toBe(recipientMixed.toLowerCase());
    // Codex r3 m2: numeric column stored as exact decimal string
    expect(claims[0].amount).toBe('12345');
    expect(claims[0].blockTimestamp.getTime()).toBe(BLOCK_TS_1.getTime());
  });

  it('multiple Claimed events for same market+recipient (different (tx,log)) → both inserted; idempotent on replay', async () => {
    const t = await setup();
    await seedConfirmedFriendly({ marketId: 31 });
    const ctx = await makeCtx(t);
    const ev1 = buildClaimedEvent({
      marketId: 31n,
      recipient: STAKER_A,
      amount: 100n,
      txHash: TX_HASH_1,
      logIndex: 0,
    });
    const ev2 = buildClaimedEvent({
      marketId: 31n,
      recipient: STAKER_A,
      amount: 200n,
      txHash: TX_HASH_2,
      logIndex: 0,
    });
    expect((await processClaimed(ctx, ev1)).outcome).toBe('inserted');
    expect((await processClaimed(ctx, ev2)).outcome).toBe('inserted');
    // Replay ev1
    expect((await processClaimed(ctx, ev1)).outcome).toBe('replay-noop');

    const claims = await t.db.select().from(pmClaims);
    expect(claims).toHaveLength(2);
  });

  it('orphan: pm_markets absent → pm_claims still inserted; outcome=orphan-event', async () => {
    const t = await setup();
    const ctx = await makeCtx(t);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const event = buildClaimedEvent({
      marketId: 999n,
      recipient: STAKER_B,
      amount: 1n,
    });
    const r = await processClaimed(ctx, event);
    expect(r.outcome).toBe('orphan-event');

    const claims = await t.db.select().from(pmClaims);
    expect(claims).toHaveLength(1);
  });

  it('uppercase blockHash normalisation (Codex r2 m1): cache lookup hits via normalizeHex', async () => {
    const t = await setup();
    await seedConfirmedFriendly({ marketId: 32 });
    // Build ctx with the cache key in lowercase form (as Phase B
    // would write it).
    const ctx = await makeCtx(t);
    // Synthesize an event whose log.blockHash is UPPERCASE — handler
    // reads via normalizeHex, so the lookup must hit.
    const upperHash = ('0x' +
      BLOCK_HASH_1.slice(2).toUpperCase()) as `0x${string}`;
    const event = buildClaimedEvent({
      marketId: 32n,
      recipient: STAKER_A,
      amount: 1n,
      blockHash: upperHash,
    });
    const r = await processClaimed(ctx, event);
    expect(r.outcome).toBe('inserted');

    const claims = await t.db.select().from(pmClaims);
    expect(claims[0].blockTimestamp.getTime()).toBe(BLOCK_TS_1.getTime());
  });

  it('throws if blockTimestamps cache lacks the entry (programmer-error guard)', async () => {
    const t = await setup();
    await seedConfirmedFriendly({ marketId: 33 });
    const ctx: HandlerCtx = {
      chunkTx: t.db as never,
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      acquiredLockedAt: new Date(),
      prefetch: new Map(),
      // Empty cache — handler should throw.
      blockTimestamps: new Map(),
    };
    const event = buildClaimedEvent({
      marketId: 33n,
      recipient: STAKER_A,
      amount: 1n,
    });
    await expect(processClaimed(ctx, event)).rejects.toThrow(
      /ctx\.blockTimestamps missing entry/,
    );
  });
});

// ---------------------------------------------------------------------------
// JSON.stringify safety + numeric-column exact-string assertions (Codex r2 M1
// + r3 m2 — combined regression guard).
// ---------------------------------------------------------------------------

describe('JSON.stringify safety + numeric-column exact-string', () => {
  it('every resolution-shaped handler payload survives JSON.stringify (no raw bigints leaked)', async () => {
    const t = await setup();
    await seedConfirmedFriendly({ marketId: 100 });
    await seedConfirmedFriendly({ marketId: 101 });
    await seedConfirmedFriendly({ marketId: 102 });
    await seedConfirmedFriendly({ marketId: 103 });
    await seedConfirmedFriendly({ marketId: 104 });
    const ctx = await makeCtx(t);

    await processResolvedFriendly(
      ctx,
      buildResolvedFriendlyEvent({
        marketId: 100n,
        outcome: 1,
        emptyPoolPath: false,
        feeTaken: 1n,
        totalOwed: 2n,
        txHash: ('0x' + '1'.repeat(64)) as `0x${string}`,
      }),
    );
    await processResolvedOpenVote(
      ctx,
      buildResolvedOpenVoteEvent({
        marketId: 101n,
        topN: [0n, 1n],
        feeTaken: 1n,
        txHash: ('0x' + '2'.repeat(64)) as `0x${string}`,
      }),
    );
    await processDistributedPrizePool(
      ctx,
      buildDistributedPrizePoolEvent({
        marketId: 102n,
        topN: [0n],
        winnerWallets: [STAKER_A],
        amountsOwed: [3n],
        feeTaken: 1n,
        txHash: ('0x' + '3'.repeat(64)) as `0x${string}`,
      }),
    );
    await processCanceled(
      ctx,
      buildCanceledEvent({
        marketId: 103n,
        reason: 0,
        txHash: ('0x' + '4'.repeat(64)) as `0x${string}`,
      }),
    );
    await processClaimed(
      ctx,
      buildClaimedEvent({
        marketId: 104n,
        recipient: STAKER_A,
        amount: 1n,
        txHash: ('0x' + '5'.repeat(64)) as `0x${string}`,
      }),
    );

    const allRes = await t.db.select().from(pmResolutions);
    expect(allRes).toHaveLength(4);
    for (const row of allRes) {
      // pglite returns payload as a parsed object; round-trip through
      // JSON.stringify proves no bigint survived.
      expect(() => JSON.stringify(row.payload)).not.toThrow();
    }
    const allClaims = await t.db.select().from(pmClaims);
    expect(allClaims).toHaveLength(1);
  });

  it('pm_markets.feeTaken stored as exact decimal string for huge bigint (precision check)', async () => {
    const t = await setup();
    await seedConfirmedFriendly({ marketId: 200 });
    const ctx = await makeCtx(t);
    // 2^60 (well outside Number.MAX_SAFE_INTEGER but well within 78-digit numeric).
    const huge = 1_152_921_504_606_846_976n;
    await processResolvedFriendly(
      ctx,
      buildResolvedFriendlyEvent({
        marketId: 200n,
        outcome: 1,
        emptyPoolPath: false,
        feeTaken: huge,
        totalOwed: huge * 9n,
      }),
    );
    const m = await t.db
      .select()
      .from(pmMarkets)
      .where(eq(pmMarkets.marketId, 200));
    expect(m[0].feeTaken).toBe(huge.toString());
    expect(m[0].feeTaken).toBe('1152921504606846976');
  });

  it('pm_claims.amount stored as exact decimal string for huge bigint (precision check)', async () => {
    const t = await setup();
    await seedConfirmedFriendly({ marketId: 201 });
    const ctx = await makeCtx(t);
    const huge = 999_999_999_999_999_999_999n; // 21 digits
    await processClaimed(
      ctx,
      buildClaimedEvent({
        marketId: 201n,
        recipient: STAKER_A,
        amount: huge,
      }),
    );
    const claims = await t.db.select().from(pmClaims);
    expect(claims[0].amount).toBe('999999999999999999999');
  });
});
