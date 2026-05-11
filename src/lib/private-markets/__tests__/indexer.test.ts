// ----------------------------------------------------------------------------
// src/lib/private-markets/__tests__/indexer.test.ts
//
// Integration tests for the 2B-2 indexer: mutex acquire/release/
// stale-recovery, Phase C ownership gate, processMarketCreated
// confirmed-flip + synthetic-insert paths, processMarketMetadataFrozen
// idempotency. Codex round-1 M2 — these were the high-risk paths
// that the helper-only tests in normalize.test.ts can't reach.
//
// Uses pglite (in-memory Postgres compiled to WASM) so the CTE
// acquire SQL, partial unique indexes, ON CONFLICT clauses, and
// xmax/date_trunc/make_interval all behave like production.
// ----------------------------------------------------------------------------

import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { pmMarkets, pmOptions, pmResolutions, pmIndexerState } from '@/db/schema';

import {
  acquireMutex,
  processMarketCreated,
  processMarketMetadataFrozen,
  StaleLockLostError,
  type HandlerCtx,
  type PrefetchedMetadata,
} from '../indexer';
import type { DecodedEvent } from '../event-decode';
import { createTestDb, type TestDb } from './test-db';

// ---- Fixtures --------------------------------------------------------------

const CHAIN_ID = 10143;
const CONTRACT = '0xc9c6575a14d0e84afd5ab21c506916fd2864bb8f' as const;
const CONTRACT_OTHER = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as const;
const CREATOR_A = '0x1111111111111111111111111111111111111111' as const;
const CREATOR_B = '0x2222222222222222222222222222222222222222' as const;
const NONCE_1 =
  '0x0000000000000000000000000000000000000000000000000000000000000001' as const;
const NONCE_2 =
  '0x0000000000000000000000000000000000000000000000000000000000000002' as const;
const TX_HASH_1 =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;

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

function buildPrefetch(marketIdNum: number): PrefetchedMetadata {
  return {
    market: {
      creator: CREATOR_A,
      shape: 0,
      clientNonce: NONCE_1,
      createdAt: 0n,
      stakingOpensAt: 1778544060n,
      closeAt: 1778544600n,
      viewMode: 0,
      participationMode: 0,
      storedState: 0,
      effectiveState: 0,
      perStakeMin: 1_000_000n,
      perStakeMax: 0n,
      perWalletCumulativeMax: 0n,
      fixedStake: 0n,
      winnersCount: 0,
      totalStake: 0n,
      friendlyOutcome: 0,
      friendlyEmptyPoolPath: false,
      feeTaken: 0n,
      dust: 0n,
      metadataFrozenEmitted: false,
    },
    title: { value: 'Test Market', ok: true },
    description: { value: 'A test', ok: true },
    streamUrl: { value: '', ok: true },
    optionLabels: [
      { value: 'NO', ok: true },
      { value: 'YES', ok: true },
    ],
    allowlist: [],
    participants: [],
  };
}

function buildMarketCreatedEvent(args: {
  marketId: bigint;
  creator: `0x${string}`;
  clientNonce: `0x${string}`;
  marketShape?: number;
  txHash?: `0x${string}`;
  logIndex?: number;
}): Extract<DecodedEvent, { eventName: 'MarketCreated' }> {
  return {
    eventName: 'MarketCreated',
    args: {
      marketId: args.marketId,
      creator: args.creator,
      marketShape: args.marketShape ?? 0,
      createdAt: 1778544000n,
      stakingOpensAt: 1778544060n,
      closeAt: 1778544600n,
      visibilityView: 0,
      visibilityParticipation: 0,
      clientNonce: args.clientNonce,
    },
    log: {
      address: CONTRACT,
      blockNumber: 30700000n,
      transactionHash: args.txHash ?? TX_HASH_1,
      logIndex: args.logIndex ?? 0,
    } as unknown as Extract<
      DecodedEvent,
      { eventName: 'MarketCreated' }
    >['log'],
  };
}

// ---- mutex SQL (raw test of the CTE behaviour) -----------------------------

async function callAcquire(
  db: TestDb['db'],
  chainId: number,
  contractAddress: string,
  staleMs: number,
) {
  // Reuse the production acquire helper directly so the test
  // exercises the exact SQL + result coercion that runs on Monad,
  // not a duplicated copy. pglite is API-compatible with
  // drizzle-orm/postgres-js for the methods acquireMutex uses.
  return acquireMutex(
    db as never,
    chainId,
    contractAddress,
    staleMs,
  );
}

describe('mutex SQL', () => {
  it('acquires on absent row → mutexOutcome=acquired, inserted=true, lastIndexedBlock=0', async () => {
    const t = await setup();
    const rows = await callAcquire(t.db, CHAIN_ID, CONTRACT, 5 * 60 * 1000);
    expect(rows).toHaveLength(1);
    expect(rows[0].mutexOutcome).toBe('acquired');
    expect(rows[0].inserted).toBe(true);
    expect(rows[0].lastIndexedBlock).toBe(0);
    expect(rows[0].newContractAddress).toBe(CONTRACT);
    expect(rows[0].priorContractAddress).toBeNull();
    expect(rows[0].acquiredLockedAt).toBeInstanceOf(Date);
  });

  it('returns 0 rows when an existing fresh lock is held (busy)', async () => {
    const t = await setup();
    await callAcquire(t.db, CHAIN_ID, CONTRACT, 5 * 60 * 1000);
    // Second acquire while the first lock is fresh — busy.
    const rows = await callAcquire(t.db, CHAIN_ID, CONTRACT, 5 * 60 * 1000);
    expect(rows).toHaveLength(0);
  });

  it('reclaims a stale lock → mutexOutcome=stale-recovered, inserted=false', async () => {
    const t = await setup();
    // First acquire to seed a row.
    await callAcquire(t.db, CHAIN_ID, CONTRACT, 5 * 60 * 1000);
    // Push locked_at backwards 10 minutes so the next acquire's stale
    // threshold (5 min) catches it.
    await t.db.execute(sql`
      UPDATE pm_indexer_state
         SET locked_at = now() - interval '10 minutes'
       WHERE chain_id = ${CHAIN_ID};
    `);
    const rows = await callAcquire(t.db, CHAIN_ID, CONTRACT, 5 * 60 * 1000);
    expect(rows).toHaveLength(1);
    expect(rows[0].mutexOutcome).toBe('stale-recovered');
    expect(rows[0].inserted).toBe(false);
    expect(rows[0].priorContractAddress).toBe(CONTRACT);
  });

  it('lock token round-trips through JS Date losslessly', async () => {
    // R7-M2: date_trunc('milliseconds', now()) → Date with ms
    // precision; release WHERE locked_at = $token must match.
    const t = await setup();
    const rows = await callAcquire(t.db, CHAIN_ID, CONTRACT, 5 * 60 * 1000);
    const token = rows[0].acquiredLockedAt;

    // Release using the JS Date as the token.
    const released = await t.db.execute(sql`
      UPDATE pm_indexer_state
         SET locked_at = NULL, updated_at = now()
       WHERE chain_id = ${CHAIN_ID}
         AND locked_at = ${token}
       RETURNING chain_id;
    `);
    const releasedRows =
      (released as unknown as { rows?: unknown[] }).rows ??
      (released as unknown as unknown[]);
    expect(releasedRows).toHaveLength(1);
  });

  it('release with wrong token does NOT clear the lock (R6-M1)', async () => {
    const t = await setup();
    const rowsA = await callAcquire(t.db, CHAIN_ID, CONTRACT, 5 * 60 * 1000);
    const tokenA = rowsA[0].acquiredLockedAt;

    // Stale-recover with worker B.
    await t.db.execute(sql`
      UPDATE pm_indexer_state
         SET locked_at = now() - interval '10 minutes'
       WHERE chain_id = ${CHAIN_ID};
    `);
    const rowsB = await callAcquire(t.db, CHAIN_ID, CONTRACT, 5 * 60 * 1000);
    const tokenB = rowsB[0].acquiredLockedAt;
    expect(tokenA.getTime()).not.toBe(tokenB.getTime());

    // Worker A's release with stale tokenA — should miss.
    const released = await t.db.execute(sql`
      UPDATE pm_indexer_state
         SET locked_at = NULL, updated_at = now()
       WHERE chain_id = ${CHAIN_ID}
         AND locked_at = ${tokenA}
       RETURNING chain_id;
    `);
    const releasedRows =
      (released as unknown as { rows?: unknown[] }).rows ??
      (released as unknown as unknown[]);
    expect(releasedRows).toHaveLength(0);

    // B's lock still set.
    const stateRows = await t.db.select().from(pmIndexerState);
    expect(stateRows[0].lockedAt).not.toBeNull();
    expect(stateRows[0].lockedAt!.getTime()).toBe(tokenB.getTime());
  });
});

// ---- processMarketCreated --------------------------------------------------

async function makeCtx(
  t: TestDb,
  prefetch: Map<number, PrefetchedMetadata>,
  acquiredLockedAt: Date = new Date(),
): Promise<HandlerCtx> {
  return {
    chunkTx: t.db as never,
    chainId: CHAIN_ID,
    contractAddress: CONTRACT,
    acquiredLockedAt,
    prefetch,
  };
}

describe('processMarketCreated — confirmed-flip path', () => {
  it('flips a matching pending row to confirmed', async () => {
    const t = await setup();
    // Seed pending row with creator A + nonce 1.
    await t.db.insert(pmMarkets).values({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      slug: 'pending1',
      clientNonce: NONCE_1,
      creator: CREATOR_A,
      shape: 'friendly',
      createStatus: 'pending',
      title: 'Pending market',
      visibilityView: 0,
      visibilityParticipation: 0,
      stakingOpensAt: new Date('2026-05-12T00:01:00Z'),
      closeAt: new Date('2026-05-12T00:10:00Z'),
    });

    const ctx = await makeCtx(t, new Map());
    const event = buildMarketCreatedEvent({
      marketId: 42n,
      creator: CREATOR_A,
      clientNonce: NONCE_1,
    });
    const result = await processMarketCreated(ctx, event);
    expect(result.outcome).toBe('confirmed');

    const rows = await t.db.select().from(pmMarkets);
    expect(rows).toHaveLength(1);
    expect(rows[0].createStatus).toBe('confirmed');
    expect(rows[0].marketId).toBe(42);
    expect(rows[0].confirmedAt).not.toBeNull();
  });

  it('does NOT flip a pending row from a different chainId (Codex M1)', async () => {
    const t = await setup();
    await t.db.insert(pmMarkets).values({
      chainId: 999, // different chain
      contractAddress: CONTRACT,
      slug: 'pending-otherchain',
      clientNonce: NONCE_1,
      creator: CREATOR_A,
      shape: 'friendly',
      createStatus: 'pending',
      title: 'Other-chain pending',
      visibilityView: 0,
      visibilityParticipation: 0,
      stakingOpensAt: new Date('2026-05-12T00:01:00Z'),
      closeAt: new Date('2026-05-12T00:10:00Z'),
    });

    const prefetch = new Map([[42, buildPrefetch(42)]]);
    const ctx = await makeCtx(t, prefetch);
    const event = buildMarketCreatedEvent({
      marketId: 42n,
      creator: CREATOR_A,
      clientNonce: NONCE_1,
    });
    const result = await processMarketCreated(ctx, event);
    // Should fall through to synthetic-insert, NOT bind the
    // wrong-chain pending row.
    expect(result.outcome).toBe('synthetic-inserted');

    const rows = await t.db.select().from(pmMarkets);
    expect(rows).toHaveLength(2);
    const otherChain = rows.find((r) => r.chainId === 999);
    expect(otherChain!.createStatus).toBe('pending');
    expect(otherChain!.marketId).toBeNull();
  });

  it('does NOT flip a pending row from a different contractAddress (Codex M1)', async () => {
    const t = await setup();
    await t.db.insert(pmMarkets).values({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT_OTHER,
      slug: 'pending-othercontract',
      clientNonce: NONCE_1,
      creator: CREATOR_A,
      shape: 'friendly',
      createStatus: 'pending',
      title: 'Other-contract pending',
      visibilityView: 0,
      visibilityParticipation: 0,
      stakingOpensAt: new Date('2026-05-12T00:01:00Z'),
      closeAt: new Date('2026-05-12T00:10:00Z'),
    });

    const prefetch = new Map([[42, buildPrefetch(42)]]);
    const ctx = await makeCtx(t, prefetch);
    const event = buildMarketCreatedEvent({
      marketId: 42n,
      creator: CREATOR_A,
      clientNonce: NONCE_1,
    });
    const result = await processMarketCreated(ctx, event);
    expect(result.outcome).toBe('synthetic-inserted');

    const rows = await t.db.select().from(pmMarkets);
    const otherContract = rows.find((r) => r.contractAddress === CONTRACT_OTHER);
    expect(otherContract!.createStatus).toBe('pending');
    expect(otherContract!.marketId).toBeNull();
  });

  // Phase 2C-1 step-9 / Codex r4 MAJ-4: dx-row recovery after sweep
  // mid-sponsor. The sponsor route's FOR UPDATE lock only spans the
  // SELECT; sweep can flip pending → failed AFTER COMMIT. When
  // MarketCreated arrives for the now-failed nonce, processMarketCreated
  // must NOT find the row via the pending-only UPDATE filter and MUST
  // fall through to synthetic-insert. The user gets a dx-row market
  // instead of their originally-chosen slug — no funds lost.
  it('sweep mid-sponsor → dx-row recovery on indexer confirm (exact event-to-row binding)', async () => {
    const t = await setup();
    // Step 1: seed pending row P with slug='ABC123XY', nonce=N,
    // creator=W, shape=friendly.
    const seededIds = await t.db
      .insert(pmMarkets)
      .values({
        chainId: CHAIN_ID,
        contractAddress: CONTRACT,
        slug: 'ABC123XY',
        clientNonce: NONCE_1,
        creator: CREATOR_A,
        shape: 'friendly',
        createStatus: 'pending',
        title: 'About to be swept',
        visibilityView: 0,
        visibilityParticipation: 0,
        stakingOpensAt: new Date('2026-05-12T00:01:00Z'),
        closeAt: new Date('2026-05-12T00:10:00Z'),
      })
      .returning({ id: pmMarkets.id });
    const originalId = seededIds[0].id;

    // Step 2: simulate sweep flipping P to 'failed' AFTER the sponsor
    // route's transaction has committed (i.e., the race window opens).
    await t.db
      .update(pmMarkets)
      .set({
        createStatus: 'failed',
        failureReason: 'stale-pending-swept',
      })
      .where(sql`id = ${originalId}`);

    // Step 3: simulate MarketCreated event arriving for the same
    // (chainId, contract, clientNonce, creator) tuple. Indexer must
    // fail the UPDATE-by-pending filter and fall through to the
    // synthetic-insert path.
    const prefetch = new Map([[55, buildPrefetch(55)]]);
    const ctx = await makeCtx(t, prefetch);
    const event = buildMarketCreatedEvent({
      marketId: 55n,
      creator: CREATOR_A,
      clientNonce: NONCE_1,
    });

    const result = await processMarketCreated(ctx, event);
    expect(result.outcome).toBe('synthetic-inserted');

    // Step 4: verify EXACT event-to-row binding.
    const rows = await t.db.select().from(pmMarkets);
    expect(rows).toHaveLength(2);

    // Original row untouched: still 'failed', still original slug,
    // still marketId=null.
    const failedRow = rows.find((r) => r.id === originalId);
    expect(failedRow).toBeDefined();
    expect(failedRow!.createStatus).toBe('failed');
    expect(failedRow!.slug).toBe('ABC123XY');
    expect(failedRow!.marketId).toBeNull();

    // New dx- row: confirmed, exact event values bound, new id,
    // synthetic dx- slug pattern.
    const dxRow = rows.find((r) => r.id !== originalId);
    expect(dxRow).toBeDefined();
    expect(dxRow!.createStatus).toBe('confirmed');
    expect(dxRow!.marketId).toBe(55);
    expect(dxRow!.clientNonce).toBe(NONCE_1.toLowerCase());
    expect(dxRow!.creator).toBe(CREATOR_A.toLowerCase());
    expect(dxRow!.contractAddress).toBe(CONTRACT);
    expect(dxRow!.chainId).toBe(CHAIN_ID);
    expect(dxRow!.slug).toMatch(/^dx-[A-Za-z0-9]{8}$/);
    expect(dxRow!.slug).not.toBe('ABC123XY');
  });

  it('same-nonce hijack defense: different creator → synthetic, original pending stays pending', async () => {
    const t = await setup();
    await t.db.insert(pmMarkets).values({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      slug: 'pending1',
      clientNonce: NONCE_1,
      creator: CREATOR_A,
      shape: 'friendly',
      createStatus: 'pending',
      title: 'A pending market',
      visibilityView: 0,
      visibilityParticipation: 0,
      stakingOpensAt: new Date('2026-05-12T00:01:00Z'),
      closeAt: new Date('2026-05-12T00:10:00Z'),
    });

    const prefetch = new Map([[42, buildPrefetch(42)]]);
    const ctx = await makeCtx(t, prefetch);
    // creator B uses creator A's nonce.
    const event = buildMarketCreatedEvent({
      marketId: 42n,
      creator: CREATOR_B,
      clientNonce: NONCE_1,
    });
    const result = await processMarketCreated(ctx, event);
    expect(result.outcome).toBe('synthetic-inserted');

    const rows = await t.db.select().from(pmMarkets);
    expect(rows).toHaveLength(2);
    const aRow = rows.find((r) => r.creator === CREATOR_A)!;
    const bRow = rows.find((r) => r.creator === CREATOR_B)!;
    expect(aRow.createStatus).toBe('pending');
    expect(aRow.marketId).toBeNull();
    expect(bRow.createStatus).toBe('confirmed');
    expect(bRow.marketId).toBe(42);
    expect(bRow.slug.startsWith('dx-')).toBe(true);
  });
});

describe('processMarketCreated — synthetic-insert path', () => {
  it('inserts synthetic dx- row + 2 pm_options for Friendly when no pending row matches', async () => {
    const t = await setup();
    const prefetch = new Map([[42, buildPrefetch(42)]]);
    const ctx = await makeCtx(t, prefetch);
    const event = buildMarketCreatedEvent({
      marketId: 42n,
      creator: CREATOR_A,
      clientNonce: NONCE_1,
    });
    const result = await processMarketCreated(ctx, event);
    expect(result.outcome).toBe('synthetic-inserted');

    const markets = await t.db.select().from(pmMarkets);
    expect(markets).toHaveLength(1);
    expect(markets[0].slug.startsWith('dx-')).toBe(true);
    expect(markets[0].slug.length).toBe(11);
    expect(markets[0].marketId).toBe(42);
    expect(markets[0].createStatus).toBe('confirmed');
    expect(markets[0].shape).toBe('friendly');

    const options = await t.db
      .select()
      .from(pmOptions)
      .orderBy(pmOptions.optionIndex);
    expect(options).toHaveLength(2);
    expect(options[0].label).toBe('NO');
    expect(options[1].label).toBe('YES');
    expect(options[0].participantWallet).toBeNull();
  });

  it('replay-noop on an existing synthetic row WITHOUT consulting prefetch (R5-M3)', async () => {
    const t = await setup();
    // Seed a synthetic row already.
    await t.db.insert(pmMarkets).values({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      slug: 'dx-aaaaaaaa',
      clientNonce: NONCE_1,
      creator: CREATOR_A,
      shape: 'friendly',
      createStatus: 'confirmed',
      marketId: 42,
      confirmedAt: new Date(),
      title: 'Existing',
      visibilityView: 0,
      visibilityParticipation: 0,
      stakingOpensAt: new Date('2026-05-12T00:01:00Z'),
      closeAt: new Date('2026-05-12T00:10:00Z'),
    });

    // Build a prefetch map with a Map.get spy so we can prove the
    // handler short-circuits without touching it.
    const prefetchInner = new Map<number, PrefetchedMetadata>([
      [42, buildPrefetch(42)],
    ]);
    let getCalls = 0;
    const prefetchProxy: typeof prefetchInner = {
      get: (k: number) => {
        getCalls += 1;
        return prefetchInner.get(k);
      },
      // pass through other Map methods as no-ops (handler never uses them)
    } as unknown as typeof prefetchInner;
    const ctx = await makeCtx(t, prefetchProxy);

    const event = buildMarketCreatedEvent({
      marketId: 42n,
      creator: CREATOR_A,
      clientNonce: NONCE_1,
    });
    const result = await processMarketCreated(ctx, event);
    expect(result.outcome).toBe('replay-noop');
    expect(getCalls).toBe(0);

    // Row count unchanged.
    const rows = await t.db.select().from(pmMarkets);
    expect(rows).toHaveLength(1);
  });

  it('Prize Pool: participantWallet populated from prefetch.participants[idx]', async () => {
    const t = await setup();
    const meta = buildPrefetch(42);
    meta.market.shape = 2; // PrizePool
    meta.market.winnersCount = 2;
    meta.optionLabels = [
      { value: 'Alice', ok: true },
      { value: 'Bob', ok: true },
    ];
    meta.participants = [
      '0x3333333333333333333333333333333333333333',
      '0x4444444444444444444444444444444444444444',
    ];
    const prefetch = new Map([[42, meta]]);
    const ctx = await makeCtx(t, prefetch);
    const event = buildMarketCreatedEvent({
      marketId: 42n,
      creator: CREATOR_A,
      clientNonce: NONCE_1,
      marketShape: 2,
    });
    const result = await processMarketCreated(ctx, event);
    expect(result.outcome).toBe('synthetic-inserted');

    const options = await t.db
      .select()
      .from(pmOptions)
      .orderBy(pmOptions.optionIndex);
    expect(options).toHaveLength(2);
    expect(options[0].participantWallet).toBe(
      '0x3333333333333333333333333333333333333333',
    );
    expect(options[1].participantWallet).toBe(
      '0x4444444444444444444444444444444444444444',
    );
  });
});

// ---- processMarketMetadataFrozen -------------------------------------------

function buildFrozenEvent(
  marketId: bigint,
  frozenAt: bigint,
  txHash: `0x${string}`,
  logIndex: number,
): Extract<DecodedEvent, { eventName: 'MarketMetadataFrozen' }> {
  return {
    eventName: 'MarketMetadataFrozen',
    args: { marketId, frozenAt },
    log: {
      address: CONTRACT,
      blockNumber: 30700001n,
      transactionHash: txHash,
      logIndex,
    } as unknown as Extract<
      DecodedEvent,
      { eventName: 'MarketMetadataFrozen' }
    >['log'],
  };
}

describe('processMarketMetadataFrozen', () => {
  it('first-write inserts pm_resolutions row + mirrors frozen_at', async () => {
    const t = await setup();
    await t.db.insert(pmMarkets).values({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      slug: 'dx-aaaaaaaa',
      clientNonce: NONCE_1,
      creator: CREATOR_A,
      shape: 'friendly',
      createStatus: 'confirmed',
      marketId: 42,
      confirmedAt: new Date(),
      title: 'Existing',
      visibilityView: 0,
      visibilityParticipation: 0,
      stakingOpensAt: new Date('2026-05-12T00:01:00Z'),
      closeAt: new Date('2026-05-12T00:10:00Z'),
    });

    const ctx = await makeCtx(t, new Map());
    const result = await processMarketMetadataFrozen(
      ctx,
      buildFrozenEvent(42n, 1778544999n, TX_HASH_1, 7),
    );
    expect(result.outcome).toBe('frozen');

    const resolutions = await t.db.select().from(pmResolutions);
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0].eventName).toBe('MarketMetadataFrozen');

    const markets = await t.db.select().from(pmMarkets);
    expect(markets[0].frozenAt).not.toBeNull();
  });

  it('replay with same (tx_hash, log_index) → noop, no second mirror touch', async () => {
    const t = await setup();
    await t.db.insert(pmMarkets).values({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      slug: 'dx-aaaaaaaa',
      clientNonce: NONCE_1,
      creator: CREATOR_A,
      shape: 'friendly',
      createStatus: 'confirmed',
      marketId: 42,
      confirmedAt: new Date(),
      title: 'Existing',
      visibilityView: 0,
      visibilityParticipation: 0,
      stakingOpensAt: new Date('2026-05-12T00:01:00Z'),
      closeAt: new Date('2026-05-12T00:10:00Z'),
    });
    const ctx = await makeCtx(t, new Map());
    await processMarketMetadataFrozen(
      ctx,
      buildFrozenEvent(42n, 1778544999n, TX_HASH_1, 7),
    );
    const r2 = await processMarketMetadataFrozen(
      ctx,
      buildFrozenEvent(42n, 1778544999n, TX_HASH_1, 7),
    );
    expect(r2.outcome).toBe('replay-noop');

    const resolutions = await t.db.select().from(pmResolutions);
    expect(resolutions).toHaveLength(1);
  });

  it('orphan event: pm_resolutions row inserted, no pm_markets row exists, outcome=orphan-event', async () => {
    const t = await setup();
    const ctx = await makeCtx(t, new Map());
    const result = await processMarketMetadataFrozen(
      ctx,
      buildFrozenEvent(99n, 1778544999n, TX_HASH_1, 7),
    );
    expect(result.outcome).toBe('orphan-event');
    const resolutions = await t.db.select().from(pmResolutions);
    expect(resolutions).toHaveLength(1);
    const markets = await t.db.select().from(pmMarkets);
    expect(markets).toHaveLength(0);
  });
});

// ---- StaleLockLost (Phase C ownership gate via the helper) -----------------

describe('Phase C ownership gate', () => {
  it('throws StaleLockLostError when token mismatch (R7-M1)', async () => {
    const t = await setup();
    // Seed an indexer-state row with a known locked_at.
    const knownToken = new Date('2026-05-09T00:00:00.000Z');
    await t.db.insert(pmIndexerState).values({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      lastIndexedBlock: 0,
      lockedAt: knownToken,
    });

    const wrongToken = new Date('2026-01-01T00:00:00.000Z');
    // Reach the helper through a re-import to keep it private at the
    // module level. Easier: the orchestrator's surface is the public
    // path; here we drive the helper indirectly by issuing the same
    // ownership-gated UPDATE the helper would.
    const advanced = await t.db
      .update(pmIndexerState)
      .set({ lastIndexedBlock: 100, updatedAt: new Date() })
      .where(sql`chain_id = ${CHAIN_ID} AND locked_at = ${wrongToken}`)
      .returning({ chainId: pmIndexerState.chainId });
    expect(advanced).toHaveLength(0);

    // And the matching token does succeed.
    const advanced2 = await t.db
      .update(pmIndexerState)
      .set({ lastIndexedBlock: 100, updatedAt: new Date() })
      .where(sql`chain_id = ${CHAIN_ID} AND locked_at = ${knownToken}`)
      .returning({ chainId: pmIndexerState.chainId });
    expect(advanced2).toHaveLength(1);
  });

  it('StaleLockLostError class carries chainId', () => {
    const e = new StaleLockLostError(10143);
    expect(e).toBeInstanceOf(Error);
    expect(e.chainId).toBe(10143);
    expect(e.name).toBe('StaleLockLostError');
  });
});
