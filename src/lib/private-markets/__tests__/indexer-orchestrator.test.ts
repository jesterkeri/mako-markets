// ----------------------------------------------------------------------------
// src/lib/private-markets/__tests__/indexer-orchestrator.test.ts
//
// Codex round-2 M2: end-to-end test of runIndexerOnce through Phase
// A (getLogs) + Phase B (multicall prefetch) + Phase C (DB
// transaction with handler dispatch + ownership-gated advance) +
// release. Mocks viem's PublicClient so we don't hit Monad; uses
// the pglite test-db harness so the SQL semantics are real.
//
// The handler-level / mutex-level tests in indexer.test.ts cover the
// individual pieces; this file exercises the wiring that ties them
// together. Specifically:
//   - acquire → bootstrap fromBlock from deployBlock
//   - chunked getLogs invoked with bigint fromBlock/toBlock
//   - multicall called with 7 reads × N MarketCreated
//   - chunkTx dispatches MarketCreated → synthetic-row INSERT
//   - last_indexed_block advances inside the chunk transaction
//   - release clears locked_at by token
//   - busy short-circuit on a held lock
//   - release-failure path surfaces releaseWarning on success result
//     (Codex round-2 m1)
// ----------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  encodeAbiParameters,
  encodeEventTopics,
  parseAbiParameters,
  type Log,
  type PublicClient,
} from 'viem';

import { privateMarketsAbi } from '@/lib/MakoPrivateMarketsV1.abi';
import { pmIndexerState, pmMarkets, pmOptions, pmStakes } from '@/db/schema';

import { isBusy, runIndexerOnce } from '../indexer';
import { createTestDb, type TestDb } from './test-db';
import { sql } from 'drizzle-orm';

const CHAIN_ID = 10143;
const CONTRACT = '0xc9c6575a14d0e84afd5ab21c506916fd2864bb8f' as const;
const DEPLOY_BLOCK = 30685165n;
const CHAIN_HEAD = 30685170n;
const CREATOR = '0x1111111111111111111111111111111111111111' as const;
const NONCE_1 =
  '0x0000000000000000000000000000000000000000000000000000000000000001' as const;

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

// ----- Synthetic log factory (mirrors event-decode.test.ts) ----------------

function buildMarketCreatedLog(
  marketId: bigint,
  blockNumber: bigint,
  logIndex: number,
): Log {
  const topics = encodeEventTopics({
    abi: privateMarketsAbi,
    eventName: 'MarketCreated',
    args: { marketId, creator: CREATOR },
  });
  const data = encodeAbiParameters(
    parseAbiParameters(
      'uint8, uint256, uint256, uint256, uint8, uint8, bytes32',
    ),
    [
      0, // shape: Friendly
      blockNumber, // createdAt
      blockNumber + 60n, // stakingOpensAt
      blockNumber + 600n, // closeAt
      0, // visibilityView
      0, // visibilityParticipation
      NONCE_1,
    ],
  );
  return {
    address: CONTRACT,
    topics: topics as unknown as Log['topics'],
    data,
    blockNumber,
    transactionHash: ('0x' + 'a'.repeat(64)) as `0x${string}`,
    transactionIndex: 0,
    logIndex,
    blockHash: ('0x' + 'b'.repeat(64)) as `0x${string}`,
    removed: false,
  } as Log;
}

// ----- Mocked PublicClient builder -----------------------------------------

interface FakeClientArgs {
  chainHead?: bigint;
  logs?: Log[];
  // Optional override for multicall return values per (functionName,
  // marketId). Default returns realistic fixture values for one
  // Friendly market.
  multicallResults?: unknown[];
  // Spies the caller can read.
  getLogsSpy?: ReturnType<typeof vi.fn>;
  multicallSpy?: ReturnType<typeof vi.fn>;
  getBlockNumberSpy?: ReturnType<typeof vi.fn>;
}

function buildFriendlyMulticallResults(): unknown[] {
  // 7 results per MarketCreated, in the order indexer.ts ships them:
  // getMarket, getMarketTitle, getMarketDescription, getMarketStreamUrl,
  // getMarketOptions, getMarketAllowlist, getMarketParticipants.
  return [
    {
      // MarketView struct
      creator: CREATOR,
      shape: 0,
      clientNonce: NONCE_1,
      createdAt: 30685166n,
      stakingOpensAt: 30685226n,
      closeAt: 30685766n,
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
    // bytes return values are 0x-hex; bytesToUtf8 decodes them
    encodeBytesUtf8('Test'), // title
    encodeBytesUtf8('A test market'), // description
    encodeBytesUtf8(''), // streamUrl
    [encodeBytesUtf8('NO'), encodeBytesUtf8('YES')], // optionLabels
    [], // allowlist
    [], // participants
  ];
}

function encodeBytesUtf8(s: string): `0x${string}` {
  const bytes = new TextEncoder().encode(s);
  return ('0x' +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')) as `0x${string}`;
}

function makeClient(args: FakeClientArgs = {}): PublicClient {
  const chainHead = args.chainHead ?? CHAIN_HEAD;
  const logs = args.logs ?? [];
  const multicallResults =
    args.multicallResults ?? buildFriendlyMulticallResults();

  const getLogs =
    args.getLogsSpy ?? vi.fn(async () => logs);
  const multicall =
    args.multicallSpy ?? vi.fn(async () => multicallResults);
  const getBlockNumber =
    args.getBlockNumberSpy ?? vi.fn(async () => chainHead);

  return {
    getLogs,
    multicall,
    getBlockNumber,
  } as unknown as PublicClient;
}

// ---------------------------------------------------------------------------

describe('runIndexerOnce — orchestrator', () => {
  it('end-to-end: acquires, fetches logs, prefetches via multicall, inserts synthetic row, advances last_indexed_block, releases', async () => {
    const t = await setup();
    const log = buildMarketCreatedLog(42n, DEPLOY_BLOCK + 1n, 0);
    const getLogsSpy = vi.fn(async () => [log]);
    const multicallSpy = vi.fn(async () => buildFriendlyMulticallResults());
    const getBlockNumberSpy = vi.fn(async () => CHAIN_HEAD);

    const result = await runIndexerOnce({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      deployBlock: DEPLOY_BLOCK,
      db: t.db as never,
      publicClient: makeClient({
        getLogsSpy,
        multicallSpy,
        getBlockNumberSpy,
      }),
      chunkSize: 1000,
      prefetchBatchSize: 50,
    });

    expect(isBusy(result)).toBe(false);
    if (isBusy(result)) return; // narrow

    expect(result.mutex).toBe('acquired');
    expect(result.fromBlock).toBe(Number(DEPLOY_BLOCK));
    expect(result.toBlock).toBe(Number(CHAIN_HEAD));
    expect(result.decodedEventCount).toBe(1);
    expect(result.marketsWritten).toBe(1);
    expect(result.releaseWarning).toBeUndefined();

    // Phase A invoked with bigint fromBlock/toBlock (R8-M2).
    expect(getLogsSpy).toHaveBeenCalled();
    const firstCall = (getLogsSpy.mock.calls as unknown[][])[0][0] as {
      fromBlock: bigint;
      toBlock: bigint;
      address: string;
    };
    expect(typeof firstCall.fromBlock).toBe('bigint');
    expect(typeof firstCall.toBlock).toBe('bigint');
    expect(firstCall.fromBlock).toBe(DEPLOY_BLOCK);
    expect(firstCall.address).toBe(CONTRACT);

    // Phase B invoked with 7 contracts for the one MarketCreated.
    expect(multicallSpy).toHaveBeenCalledTimes(1);
    const mcArgs = (multicallSpy.mock.calls as unknown[][])[0][0] as {
      allowFailure: boolean;
      contracts: Array<{ functionName: string; args: readonly unknown[] }>;
    };
    expect(mcArgs.allowFailure).toBe(false);
    expect(mcArgs.contracts).toHaveLength(7);
    expect(mcArgs.contracts.map((c) => c.functionName)).toEqual([
      'getMarket',
      'getMarketTitle',
      'getMarketDescription',
      'getMarketStreamUrl',
      'getMarketOptions',
      'getMarketAllowlist',
      'getMarketParticipants',
    ]);
    expect(typeof mcArgs.contracts[0].args[0]).toBe('bigint');
    expect(mcArgs.contracts[0].args[0]).toBe(42n);

    // Phase C: synthetic dx- row + 2 options inserted.
    const markets = await t.db.select().from(pmMarkets);
    expect(markets).toHaveLength(1);
    expect(markets[0].slug.startsWith('dx-')).toBe(true);
    expect(markets[0].marketId).toBe(42);
    expect(markets[0].createStatus).toBe('confirmed');
    expect(markets[0].title).toBe('Test');

    const options = await t.db
      .select()
      .from(pmOptions)
      .orderBy(pmOptions.optionIndex);
    expect(options).toHaveLength(2);
    expect(options.map((o) => o.label)).toEqual(['NO', 'YES']);

    // pm_indexer_state advanced + lock released.
    const stateRows = await t.db.select().from(pmIndexerState);
    expect(stateRows).toHaveLength(1);
    expect(stateRows[0].lastIndexedBlock).toBe(Number(CHAIN_HEAD));
    expect(stateRows[0].lockedAt).toBeNull();
    expect(stateRows[0].contractAddress).toBe(CONTRACT);
  });

  it('busy short-circuit: returns null fromBlock/toBlock without invoking RPC', async () => {
    const t = await setup();
    // Hold the lock with a fresh locked_at.
    await t.db.execute(sql`
      INSERT INTO pm_indexer_state (chain_id, contract_address, last_indexed_block, locked_at, updated_at)
      VALUES (${CHAIN_ID}, ${CONTRACT}, 0, date_trunc('milliseconds', now()), now());
    `);

    const getLogsSpy = vi.fn(async () => []);
    const multicallSpy = vi.fn(async () => []);
    const getBlockNumberSpy = vi.fn(async () => CHAIN_HEAD);

    const result = await runIndexerOnce({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      deployBlock: DEPLOY_BLOCK,
      db: t.db as never,
      publicClient: makeClient({
        getLogsSpy,
        multicallSpy,
        getBlockNumberSpy,
      }),
    });

    expect(isBusy(result)).toBe(true);
    expect(result.mutex).toBe('busy');
    expect(result.fromBlock).toBeNull();
    expect(result.toBlock).toBeNull();
    expect(result.decodedEventCount).toBe(0);
    expect(result.marketsWritten).toBe(0);

    // No RPC was invoked.
    expect(getBlockNumberSpy).not.toHaveBeenCalled();
    expect(getLogsSpy).not.toHaveBeenCalled();
    expect(multicallSpy).not.toHaveBeenCalled();
  });

  it('reorg buffer: subsequent run starts at last_indexed_block - 11', async () => {
    const t = await setup();
    // Pretend a previous run already advanced to block N.
    await t.db.execute(sql`
      INSERT INTO pm_indexer_state (chain_id, contract_address, last_indexed_block, locked_at, updated_at)
      VALUES (${CHAIN_ID}, ${CONTRACT}, ${Number(DEPLOY_BLOCK + 1000n)}, NULL, now());
    `);

    const getLogsSpy = vi.fn(async () => []);
    const multicallSpy = vi.fn(async () => []);
    const newHead = DEPLOY_BLOCK + 1010n;
    const getBlockNumberSpy = vi.fn(async () => newHead);

    const result = await runIndexerOnce({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      deployBlock: DEPLOY_BLOCK,
      db: t.db as never,
      publicClient: makeClient({
        getLogsSpy,
        multicallSpy,
        getBlockNumberSpy,
      }),
    });

    expect(isBusy(result)).toBe(false);
    if (isBusy(result)) return;
    // last - 11 = 30685165 + 1000 - 11 = 30686154 (one less than last - 10)
    expect(result.fromBlock).toBe(Number(DEPLOY_BLOCK + 1000n - 11n));
    expect(getLogsSpy).toHaveBeenCalled();
    const args0 = (getLogsSpy.mock.calls as unknown[][])[0][0] as { fromBlock: bigint };
    expect(args0.fromBlock).toBe(DEPLOY_BLOCK + 1000n - 11n);
  });

  it('Phase B batches multicall by prefetchBatchSize across multiple MarketCreated events (Codex round-3 m1)', async () => {
    const t = await setup();
    // 3 MarketCreated logs in the same chunk, prefetchBatchSize=2 →
    // expect 2 multicall calls: first with 2 markets (14 contracts),
    // second with 1 (7 contracts). Each market's metadata must
    // round-trip through the 7-stride correctly.
    const logs = [
      buildMarketCreatedLog(101n, DEPLOY_BLOCK + 1n, 0),
      buildMarketCreatedLog(102n, DEPLOY_BLOCK + 1n, 1),
      buildMarketCreatedLog(103n, DEPLOY_BLOCK + 2n, 0),
    ];

    function metaFor(marketId: bigint, title: string, options: string[]): unknown[] {
      return [
        {
          creator: CREATOR,
          shape: 0,
          clientNonce: NONCE_1,
          createdAt: 30685166n,
          stakingOpensAt: 30685226n,
          closeAt: 30685766n,
          viewMode: 0,
          participationMode: 0,
          storedState: 0,
          effectiveState: 0,
          perStakeMin: marketId * 1000n, // distinct per market for stride check
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
        encodeBytesUtf8(title),
        encodeBytesUtf8(`desc-${marketId}`),
        encodeBytesUtf8(''),
        options.map(encodeBytesUtf8),
        [],
        [],
      ];
    }

    // Phase B's contracts array is interleaved by market within a
    // batch (7 reads × N markets). Mock by inspecting which market's
    // args[0] was at position 0 in each call and returning the right
    // metadata in stride.
    const multicallSpy = vi.fn(async (args: { contracts: Array<{ args: readonly unknown[] }> }) => {
      const results: unknown[] = [];
      // Walk the contracts list in stride-7. Position 0 within each
      // 7-stride carries the marketId (because every entry in the
      // stride uses the same marketId, we read the first).
      const batchSize = args.contracts.length / 7;
      for (let i = 0; i < batchSize; i++) {
        const marketId = args.contracts[i * 7].args[0] as bigint;
        const meta = metaFor(
          marketId,
          `Title-${marketId}`,
          [`A-${marketId}`, `B-${marketId}`],
        );
        results.push(...meta);
      }
      return results;
    });

    const result = await runIndexerOnce({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      deployBlock: DEPLOY_BLOCK,
      db: t.db as never,
      publicClient: makeClient({
        logs,
        multicallSpy: multicallSpy as unknown as ReturnType<typeof vi.fn>,
      }),
      chunkSize: 1000,
      prefetchBatchSize: 2,
    });

    expect(isBusy(result)).toBe(false);
    if (isBusy(result)) return;
    expect(result.marketsWritten).toBe(3);

    // Two multicall invocations: first 14 contracts (2 markets × 7),
    // second 7 contracts (1 market × 7).
    expect(multicallSpy).toHaveBeenCalledTimes(2);
    const call1 = (multicallSpy.mock.calls as unknown[][])[0][0] as {
      contracts: unknown[];
    };
    const call2 = (multicallSpy.mock.calls as unknown[][])[1][0] as {
      contracts: unknown[];
    };
    expect(call1.contracts).toHaveLength(14);
    expect(call2.contracts).toHaveLength(7);

    // Every market landed in the DB with its own metadata —
    // stride mapping was correct.
    const markets = await t.db.select().from(pmMarkets);
    expect(markets).toHaveLength(3);
    for (const m of markets) {
      expect(m.title).toBe(`Title-${m.marketId}`);
      // `perStakeMin` is numeric(78,0) → string in JS; assert the
      // distinct-per-market value round-tripped through the 7-stride.
      expect(m.perStakeMin).toBe((BigInt(m.marketId!) * 1000n).toString());
    }

    // Each market got its own option labels.
    for (const m of markets) {
      const opts = await t.db
        .select()
        .from(pmOptions)
        .where(sql`market_db_id = ${m.id}`)
        .orderBy(pmOptions.optionIndex);
      expect(opts.map((o) => o.label)).toEqual([
        `A-${m.marketId}`,
        `B-${m.marketId}`,
      ]);
    }
  });

  it('Phase B prefetches getOptionFirstStakeSequence for Staked events and Phase C wires it (2B-3)', async () => {
    const t = await setup();
    // Seed a confirmed market + 2 options so the Staked handler can
    // hit the existing pm_options row (no orphan).
    const marketRows = await t.db
      .insert(pmMarkets)
      .values({
        chainId: CHAIN_ID,
        contractAddress: CONTRACT,
        slug: 'dx-existing0',
        clientNonce: NONCE_1,
        creator: CREATOR,
        marketId: 5,
        shape: 'friendly',
        createStatus: 'confirmed',
        confirmedAt: new Date(),
        title: 'Pre-existing',
        visibilityView: 0,
        visibilityParticipation: 0,
        stakingOpensAt: new Date('2026-05-12T00:01:00Z'),
        closeAt: new Date('2026-05-12T00:10:00Z'),
      })
      .returning({ id: pmMarkets.id });
    await t.db.insert(pmOptions).values([
      {
        marketDbId: marketRows[0].id,
        optionIndex: 0,
        label: 'NO',
        participantWallet: null,
        poolTotal: '0',
        firstStakeSequence: null,
      },
      {
        marketDbId: marketRows[0].id,
        optionIndex: 1,
        label: 'YES',
        participantWallet: null,
        poolTotal: '0',
        firstStakeSequence: null,
      },
    ]);

    // Build a Staked log via encode helpers (mirrors event-decode
    // tests' approach).
    const stakedTopics = encodeEventTopics({
      abi: privateMarketsAbi,
      eventName: 'Staked',
      args: { marketId: 5n, staker: CREATOR },
    });
    const stakedData = encodeAbiParameters(
      parseAbiParameters('uint256, uint256, uint256'),
      [1n, 3_000_000n, 1778544100n], // optionIndex, amount, timestamp
    );
    const stakedLog = {
      address: CONTRACT,
      topics: stakedTopics as unknown as Log['topics'],
      data: stakedData,
      blockNumber: DEPLOY_BLOCK + 1n,
      transactionHash: ('0x' + 'd'.repeat(64)) as `0x${string}`,
      transactionIndex: 0,
      logIndex: 0,
      blockHash: ('0x' + 'e'.repeat(64)) as `0x${string}`,
      removed: false,
    } as Log;

    // multicall must respond to BOTH MarketCreated reads (none in
    // this chunk) AND getOptionFirstStakeSequence reads. We only have
    // one Staked event, so expect exactly one multicall with one
    // contract returning the (sequence, isSet) tuple.
    const multicallSpy = vi.fn(
      async (args: { contracts: Array<{ functionName: string }> }) => {
        // The orchestrator runs MarketCreated prefetch first (skipped
        // here — empty array, so the loop body never runs and
        // multicall is never called for it). Staked prefetch is
        // a separate multicall call.
        if (
          args.contracts.length === 1 &&
          args.contracts[0].functionName === 'getOptionFirstStakeSequence'
        ) {
          return [[7, true]] as const;
        }
        throw new Error(
          `unexpected multicall: ${JSON.stringify(args.contracts.map((c) => c.functionName))}`,
        );
      },
    );

    const result = await runIndexerOnce({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      deployBlock: DEPLOY_BLOCK,
      db: t.db as never,
      publicClient: makeClient({
        logs: [stakedLog],
        multicallSpy: multicallSpy as unknown as ReturnType<typeof vi.fn>,
      }),
    });

    expect(isBusy(result)).toBe(false);
    if (isBusy(result)) return;
    expect(result.decodedEventCount).toBe(1);
    // Staked is NOT a MarketCreated → marketsWritten stays 0.
    expect(result.marketsWritten).toBe(0);

    // multicall called exactly once for the Staked prefetch.
    expect(multicallSpy).toHaveBeenCalledTimes(1);
    const mcArgs = (multicallSpy.mock.calls as unknown[][])[0][0] as {
      contracts: Array<{
        functionName: string;
        args: readonly unknown[];
      }>;
    };
    expect(mcArgs.contracts).toHaveLength(1);
    expect(mcArgs.contracts[0].functionName).toBe(
      'getOptionFirstStakeSequence',
    );
    // Args are [marketId: bigint, optionIndex: bigint] per the ABI.
    expect(mcArgs.contracts[0].args[0]).toBe(5n);
    expect(mcArgs.contracts[0].args[1]).toBe(1n);

    // Phase C: pm_stakes row inserted, pm_options.poolTotal +=
    // 3_000_000, firstStakeSequence = 7 on YES (option 1).
    const stakes = await t.db.select().from(pmStakes);
    expect(stakes).toHaveLength(1);
    expect(stakes[0].amount).toBe('3000000');

    const opts = await t.db
      .select()
      .from(pmOptions)
      .orderBy(pmOptions.optionIndex);
    expect(opts[0].poolTotal).toBe('0'); // NO untouched
    expect(opts[1].poolTotal).toBe('3000000'); // YES bumped
    expect(opts[1].firstStakeSequence).toBe(7);
  });

  it('release-failure surfaces releaseWarning on success result (Codex round-2 m1)', async () => {
    const t = await setup();
    const log = buildMarketCreatedLog(7n, DEPLOY_BLOCK + 1n, 0);

    // Wrap pglite client so the second .execute call (the release SQL
    // — final step in the orchestrator) throws. The first .execute is
    // the acquire; further .execute calls happen inside the chunkTx
    // transaction. Drizzle's update().where() goes through .execute()
    // on the underlying client too, so we count how many we've seen
    // and only inject the failure on what we expect to be the release.
    //
    // Simpler: monkey-patch the test db's `update` method to fail
    // when the chainId-only WHERE pattern matches release. But that's
    // fragile. Instead, use a vi.spyOn on the db's update method to
    // throw on the second invocation (the first is the Phase C
    // ownership-gated advance).
    // Phase C's advance runs on chunkTx (passed into the
    // coordinationDb.transaction callback), not the top-level db,
    // so it doesn't hit this spy. The ONLY direct t.db.update on
    // pmIndexerState that this spy sees is the release in the
    // finally block — exactly what we want to fail.
    const originalUpdate = t.db.update.bind(t.db);
    const updateSpy = vi.spyOn(t.db, 'update').mockImplementation((table) => {
      if (table === pmIndexerState) {
        throw new Error('simulated release failure');
      }
      return originalUpdate(table);
    });

    const result = await runIndexerOnce({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      deployBlock: DEPLOY_BLOCK,
      db: t.db as never,
      publicClient: makeClient({ logs: [log] }),
    });

    updateSpy.mockRestore();

    expect(isBusy(result)).toBe(false);
    if (isBusy(result)) return;
    expect(result.mutex).toBe('acquired');
    expect(result.marketsWritten).toBe(1);
    expect(result.releaseWarning).toBeDefined();
    expect(result.releaseWarning).toMatch(/simulated release failure/);
  });
});
