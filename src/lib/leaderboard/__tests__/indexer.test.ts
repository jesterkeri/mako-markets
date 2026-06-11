// ----------------------------------------------------------------------------
// #186 Leaderboard indexer — integration tests on the pglite harness.
//
// Covers the plan's Phase B test list: chunk ingest + field mapping
// (incl. the checksummed-actor → lowercase regression), idempotent
// re-run, cursor advance, halve-on-error, never-scan-past-
// confirmations, multi-contract isolation, busy short-circuit, stale
// recovery, time budget, DB CHECK enforcement, and the
// STALE_LOCK > maxDuration constant relationship (which parses the
// cron route source so a drifted literal fails CI, not prod).
// ----------------------------------------------------------------------------

import { describe, expect, it, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import type { PublicClient } from 'viem';

import {
  runLeaderboardIndexerOnce,
  LEADERBOARD_CONFIRMATIONS,
  LEADERBOARD_STALE_LOCK_MS,
  LEADERBOARD_CRON_MAX_DURATION_S,
} from '@/lib/leaderboard/indexer';
import type { LeaderboardContract } from '@/lib/leaderboard/contracts';
import {
  makoMarketEvents,
  makoLeaderboardIndexerState,
} from '@/db/schema';
import { createTestDb, type TestDb } from './test-db';

// ---- Fixtures ----------------------------------------------------------------

// Checksummed on purpose: the ledger must store lowercase even though
// viem returns EIP-55 mixed case (the safe_address casing class of bug).
const BETTOR_CHECKSUMMED = '0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195';
const BETTOR_LOWER = BETTOR_CHECKSUMMED.toLowerCase();
const CLAIMER = '0xC8BF886f73E4371CBd8160EEA7683b8Da98190F1';
const CLAIMER_LOWER = CLAIMER.toLowerCase();

const CONTRACT_A: LeaderboardContract = {
  // Lowercase per the config contract; the runner normalizes anyway.
  address: '0x00000000000000000000000000000000000000aa',
  deployBlock: 100,
  version: 'v4',
};
const CONTRACT_B: LeaderboardContract = {
  address: '0x00000000000000000000000000000000000000bb',
  deployBlock: 300,
  version: 'v4',
};

function hex32(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(64, '0')}` as `0x${string}`;
}

interface FixtureLog {
  eventName: 'BetPlaced' | 'Claimed' | 'CreatorFeePaid';
  args: Record<string, unknown>;
  address: `0x${string}`;
  blockNumber: bigint;
  blockHash: `0x${string}`;
  transactionHash: `0x${string}`;
  logIndex: number;
}

function betLog(over: Partial<FixtureLog> = {}): FixtureLog {
  return {
    eventName: 'BetPlaced',
    args: { id: 3n, user: BETTOR_CHECKSUMMED, isYes: true, amount: 5_000_000n },
    address: CONTRACT_A.address,
    blockNumber: 150n,
    blockHash: hex32(150),
    transactionHash: hex32(9001),
    logIndex: 0,
    ...over,
  };
}

function claimLog(over: Partial<FixtureLog> = {}): FixtureLog {
  return {
    eventName: 'Claimed',
    args: { id: 3n, user: CLAIMER, amount: 9_500_000n },
    address: CONTRACT_A.address,
    blockNumber: 200n,
    blockHash: hex32(200),
    transactionHash: hex32(9002),
    logIndex: 1,
    ...over,
  };
}

function feeLog(over: Partial<FixtureLog> = {}): FixtureLog {
  return {
    eventName: 'CreatorFeePaid',
    args: { id: 3n, creator: BETTOR_CHECKSUMMED, amount: 120_000n },
    address: CONTRACT_A.address,
    blockNumber: 200n,
    blockHash: hex32(200),
    transactionHash: hex32(9002),
    logIndex: 2,
    ...over,
  };
}

interface MockClientOpts {
  head: number;
  logs: FixtureLog[];
  /// Throw on getLogs spans wider than this (simulates the public
  /// RPC's range cap). Infinity = never throw.
  maxSpan?: number;
}

interface GetLogsCall {
  address: string;
  fromBlock: number;
  toBlock: number;
}

function mockClient(opts: MockClientOpts): {
  client: PublicClient;
  calls: GetLogsCall[];
} {
  const calls: GetLogsCall[] = [];
  const maxSpan = opts.maxSpan ?? Infinity;
  const client = {
    getBlockNumber: async () => BigInt(opts.head),
    getLogs: async (args: {
      address: `0x${string}`;
      fromBlock: bigint;
      toBlock: bigint;
    }) => {
      const fromBlock = Number(args.fromBlock);
      const toBlock = Number(args.toBlock);
      calls.push({ address: args.address, fromBlock, toBlock });
      const span = toBlock - fromBlock + 1;
      if (span > maxSpan) {
        throw new Error(`mock RPC: range too wide (${span} > ${maxSpan})`);
      }
      return opts.logs.filter(
        (l) =>
          l.address === args.address &&
          Number(l.blockNumber) >= fromBlock &&
          Number(l.blockNumber) <= toBlock,
      );
    },
    getBlock: async (args: { blockHash: `0x${string}` }) => ({
      // Deterministic timestamp derived from the hash's embedded number.
      timestamp: BigInt(1_700_000_000 + parseInt(args.blockHash.slice(-8), 16)),
    }),
  };
  return { client: client as unknown as PublicClient, calls };
}

// ---- Harness lifecycle -------------------------------------------------------

let testDb: TestDb | null = null;

afterEach(async () => {
  if (testDb) {
    await testDb.close();
    testDb = null;
  }
});

async function freshDb(): Promise<TestDb> {
  testDb = await createTestDb();
  return testDb;
}

const CHAIN = 10143;

// ---- Tests -------------------------------------------------------------------

describe('runLeaderboardIndexerOnce', () => {
  it('ingests a chunk and maps fields, lowercasing checksummed actors', async () => {
    const { db } = await freshDb();
    const { client, calls } = mockClient({
      head: 1000,
      logs: [betLog(), claimLog(), feeLog()],
    });

    const result = await runLeaderboardIndexerOnce({
      // pglite handle → DbOrTx: same `as never` the PM orchestrator
      // tests use (runtime surface is identical for what the runner
      // touches; postgres-js vs pglite generics diverge structurally).
      db: db as never,
      publicClient: client,
      chainId: CHAIN,
      contracts: [CONTRACT_A],
      chunkSize: 1000,
    });

    const c = result.contracts[0];
    expect(c.mutex).toBe('acquired');
    expect(c.fromBlock).toBe(100);
    expect(c.scanTarget).toBe(1000 - LEADERBOARD_CONFIRMATIONS);
    expect(c.scannedTo).toBe(1000 - LEADERBOARD_CONFIRMATIONS);
    expect(c.eventsInserted).toBe(3);
    expect(c.upToDate).toBe(true);
    expect(c.budgetExhausted).toBe(false);

    // getLogs must be address-scoped (plan NIT-4).
    expect(calls.every((call) => call.address === CONTRACT_A.address)).toBe(
      true,
    );

    const rows = await db
      .select()
      .from(makoMarketEvents)
      .orderBy(makoMarketEvents.logIndex);
    expect(rows).toHaveLength(3);

    const bet = rows[0];
    expect(bet.kind).toBe('bet');
    expect(bet.actor).toBe(BETTOR_LOWER); // checksummed input → lowercase
    expect(bet.isYes).toBe(true);
    expect(bet.amount).toBe('5000000');
    expect(bet.marketId).toBe('3');
    expect(bet.version).toBe('v4');
    expect(bet.contractAddress).toBe(CONTRACT_A.address);

    const claim = rows[1];
    expect(claim.kind).toBe('claim');
    expect(claim.actor).toBe(CLAIMER_LOWER);
    expect(claim.isYes).toBeNull();
    expect(claim.amount).toBe('9500000');

    const fee = rows[2];
    expect(fee.kind).toBe('creator_fee');
    expect(fee.actor).toBe(BETTOR_LOWER);
    expect(fee.isYes).toBeNull();

    // Cursor advanced + lock released.
    const [state] = await db.select().from(makoLeaderboardIndexerState);
    expect(state.lastScannedBlock).toBe(1000 - LEADERBOARD_CONFIRMATIONS);
    expect(state.lockedAt).toBeNull();
  });

  it('is idempotent: re-scanning the same range inserts no duplicates', async () => {
    const { db } = await freshDb();
    const { client } = mockClient({
      head: 1000,
      logs: [betLog(), claimLog(), feeLog()],
    });
    const argsBase = {
      // pglite handle → DbOrTx: same `as never` the PM orchestrator
      // tests use (runtime surface is identical for what the runner
      // touches; postgres-js vs pglite generics diverge structurally).
      db: db as never,
      publicClient: client,
      chainId: CHAIN,
      contracts: [CONTRACT_A],
      chunkSize: 1000,
    };

    await runLeaderboardIndexerOnce(argsBase);
    // Force a full re-scan of the same range (simulates a crash between
    // insert-commit and a hypothetical later failure, or a manual
    // cursor reset).
    await db
      .update(makoLeaderboardIndexerState)
      .set({ lastScannedBlock: 0 });
    const second = await runLeaderboardIndexerOnce(argsBase);

    // Re-scan re-encountered all 3 logs but the PK swallowed them.
    expect(second.contracts[0].mutex).toBe('acquired');
    const rows = await db.select().from(makoMarketEvents);
    expect(rows).toHaveLength(3);
    const [state] = await db.select().from(makoLeaderboardIndexerState);
    expect(state.lastScannedBlock).toBe(1000 - LEADERBOARD_CONFIRMATIONS);
  });

  it('never scans past head − CONFIRMATIONS', async () => {
    const { db } = await freshDb();
    const { client, calls } = mockClient({ head: 1000, logs: [] });

    await runLeaderboardIndexerOnce({
      // pglite handle → DbOrTx: same `as never` the PM orchestrator
      // tests use (runtime surface is identical for what the runner
      // touches; postgres-js vs pglite generics diverge structurally).
      db: db as never,
      publicClient: client,
      chainId: CHAIN,
      contracts: [CONTRACT_A],
      chunkSize: 200,
      confirmations: 16,
    });

    expect(calls.length).toBeGreaterThan(0);
    const maxToBlock = Math.max(...calls.map((c) => c.toBlock));
    expect(maxToBlock).toBe(984);
    const [state] = await db.select().from(makoLeaderboardIndexerState);
    expect(state.lastScannedBlock).toBe(984);
  });

  it('halves the span on RPC range errors and still ingests everything', async () => {
    const { db } = await freshDb();
    // Public-RPC simulation: any span over 100 blocks throws.
    const { client, calls } = mockClient({
      head: 1000,
      logs: [betLog(), claimLog(), feeLog()],
      maxSpan: 100,
    });

    const result = await runLeaderboardIndexerOnce({
      // pglite handle → DbOrTx: same `as never` the PM orchestrator
      // tests use (runtime surface is identical for what the runner
      // touches; postgres-js vs pglite generics diverge structurally).
      db: db as never,
      publicClient: client,
      chainId: CHAIN,
      contracts: [CONTRACT_A],
      chunkSize: 1000, // deliberately over the cap to force halving
    });

    expect(result.contracts[0].eventsInserted).toBe(3);
    expect(result.contracts[0].upToDate).toBe(true);
    // At least one oversized attempt got rejected, then halved retries
    // succeeded.
    expect(calls.some((c) => c.toBlock - c.fromBlock + 1 > 100)).toBe(true);
    expect(calls.some((c) => c.toBlock - c.fromBlock + 1 <= 100)).toBe(true);
    const rows = await db.select().from(makoMarketEvents);
    expect(rows).toHaveLength(3);
  });

  it('keeps contracts isolated: per-contract cursors and rows', async () => {
    const { db } = await freshDb();
    const { client } = mockClient({
      head: 1000,
      logs: [
        betLog(), // contract A
        betLog({
          address: CONTRACT_B.address,
          blockNumber: 400n,
          blockHash: hex32(400),
          transactionHash: hex32(9100),
          logIndex: 0,
          args: { id: 1n, user: CLAIMER, isYes: false, amount: 1_000_000n },
        }),
      ],
    });

    const result = await runLeaderboardIndexerOnce({
      // pglite handle → DbOrTx: same `as never` the PM orchestrator
      // tests use (runtime surface is identical for what the runner
      // touches; postgres-js vs pglite generics diverge structurally).
      db: db as never,
      publicClient: client,
      chainId: CHAIN,
      contracts: [CONTRACT_A, CONTRACT_B],
      chunkSize: 1000,
    });

    expect(result.contracts).toHaveLength(2);
    expect(result.contracts[0].eventsInserted).toBe(1);
    expect(result.contracts[1].eventsInserted).toBe(1);

    const states = await db.select().from(makoLeaderboardIndexerState);
    expect(states).toHaveLength(2);

    const rows = await db.select().from(makoMarketEvents);
    const aRows = rows.filter((r) => r.contractAddress === CONTRACT_A.address);
    const bRows = rows.filter((r) => r.contractAddress === CONTRACT_B.address);
    expect(aRows).toHaveLength(1);
    expect(bRows).toHaveLength(1);
    expect(bRows[0].isYes).toBe(false);
  });

  it('short-circuits busy when another worker holds a fresh lock', async () => {
    const { db } = await freshDb();
    await db.insert(makoLeaderboardIndexerState).values({
      chainId: CHAIN,
      contractAddress: CONTRACT_A.address,
      lastScannedBlock: 500,
      lockedAt: new Date(), // fresh — NOT stale
    });
    const { client, calls } = mockClient({ head: 1000, logs: [betLog()] });

    const result = await runLeaderboardIndexerOnce({
      // pglite handle → DbOrTx: same `as never` the PM orchestrator
      // tests use (runtime surface is identical for what the runner
      // touches; postgres-js vs pglite generics diverge structurally).
      db: db as never,
      publicClient: client,
      chainId: CHAIN,
      contracts: [CONTRACT_A],
    });

    expect(result.contracts[0].mutex).toBe('busy');
    expect(result.contracts[0].eventsInserted).toBe(0);
    expect(calls).toHaveLength(0); // never touched the RPC
    const rows = await db.select().from(makoMarketEvents);
    expect(rows).toHaveLength(0);
    // The foreign lock is untouched.
    const [state] = await db.select().from(makoLeaderboardIndexerState);
    expect(state.lockedAt).not.toBeNull();
    expect(state.lastScannedBlock).toBe(500);
  });

  it('stale-recovers an expired lock and resumes from the stored cursor', async () => {
    const { db } = await freshDb();
    await db.insert(makoLeaderboardIndexerState).values({
      chainId: CHAIN,
      contractAddress: CONTRACT_A.address,
      lastScannedBlock: 149, // bet at block 150 is still unscanned
      lockedAt: new Date(Date.now() - 10 * 60 * 1000), // stale (> 5 min)
    });
    const { client, calls } = mockClient({ head: 1000, logs: [betLog()] });

    const result = await runLeaderboardIndexerOnce({
      // pglite handle → DbOrTx: same `as never` the PM orchestrator
      // tests use (runtime surface is identical for what the runner
      // touches; postgres-js vs pglite generics diverge structurally).
      db: db as never,
      publicClient: client,
      chainId: CHAIN,
      contracts: [CONTRACT_A],
      chunkSize: 1000,
    });

    expect(result.contracts[0].mutex).toBe('stale-recovered');
    // Resumed at cursor + 1, not deployBlock.
    expect(result.contracts[0].fromBlock).toBe(150);
    expect(calls[0].fromBlock).toBe(150);
    const rows = await db.select().from(makoMarketEvents);
    expect(rows).toHaveLength(1);
  });

  it('stops cleanly when the time budget is exhausted', async () => {
    const { db } = await freshDb();
    const { client } = mockClient({ head: 1000, logs: [betLog()] });

    const result = await runLeaderboardIndexerOnce({
      // pglite handle → DbOrTx: same `as never` the PM orchestrator
      // tests use (runtime surface is identical for what the runner
      // touches; postgres-js vs pglite generics diverge structurally).
      db: db as never,
      publicClient: client,
      chainId: CHAIN,
      contracts: [CONTRACT_A],
      timeBudgetMs: -1000, // already past deadline at entry
    });

    const c = result.contracts[0];
    expect(c.budgetExhausted).toBe(true);
    expect(c.eventsInserted).toBe(0);
    expect(c.upToDate).toBe(false);
    // Lock released despite the early stop.
    const [state] = await db.select().from(makoLeaderboardIndexerState);
    expect(state.lockedAt).toBeNull();
  });
});

describe('0008 CHECK constraints (live in the harness, not just documented)', () => {
  it('rejects a claim row carrying is_yes', async () => {
    const { db } = await freshDb();
    await expect(
      db.insert(makoMarketEvents).values({
        chainId: CHAIN,
        contractAddress: CONTRACT_A.address,
        version: 'v4',
        marketId: '1',
        kind: 'claim',
        actor: CLAIMER_LOWER,
        isYes: true, // violates is_yes-iff-bet
        amount: '1',
        blockNumber: 1,
        blockTimestamp: new Date(),
        txHash: hex32(1),
        logIndex: 0,
      }),
    ).rejects.toThrow();
  });

  it('rejects a checksummed (non-lowercase) actor at the DB layer', async () => {
    const { db } = await freshDb();
    await expect(
      db.insert(makoMarketEvents).values({
        chainId: CHAIN,
        contractAddress: CONTRACT_A.address,
        version: 'v4',
        marketId: '1',
        kind: 'bet',
        actor: BETTOR_CHECKSUMMED as `0x${string}`, // mixed case
        isYes: true,
        amount: '1',
        blockNumber: 1,
        blockTimestamp: new Date(),
        txHash: hex32(2),
        logIndex: 0,
      }),
    ).rejects.toThrow();
  });

  it('rejects an unknown kind', async () => {
    const { db } = await freshDb();
    await expect(
      db.execute(sql`
        INSERT INTO mako_market_events
          (chain_id, contract_address, version, market_id, kind, actor,
           amount, block_number, block_timestamp, tx_hash, log_index)
        VALUES
          (${CHAIN}, ${CONTRACT_A.address}, 'v4', '1', 'resolution',
           ${CLAIMER_LOWER}, '1', 1, now(), ${hex32(3)}, 0)
      `),
    ).rejects.toThrow();
  });
});

describe('lock/timeout constant relationship (Codex r1 MINOR-2)', () => {
  it('stale-lock threshold exceeds the cron maxDuration', () => {
    expect(LEADERBOARD_STALE_LOCK_MS).toBeGreaterThan(
      LEADERBOARD_CRON_MAX_DURATION_S * 1000,
    );
  });

  it('cron route maxDuration literal matches the shared constant', () => {
    // Next.js requires a static literal in the route file; this pins it
    // to the constant so drift fails CI instead of silently shipping a
    // tick window the stale-lock threshold wasn't sized for.
    const routeSrc = readFileSync(
      resolve('src/app/api/cron/leaderboard/route.ts'),
      'utf-8',
    );
    const match = routeSrc.match(/export const maxDuration = (\d+)/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(LEADERBOARD_CRON_MAX_DURATION_S);
  });
});
