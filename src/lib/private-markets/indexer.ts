import 'server-only';

// ----------------------------------------------------------------------------
// src/lib/private-markets/indexer.ts
//
// Phase 2B-2: event-driven indexer for MakoPrivateMarketsV1's
// MarketCreated and MarketMetadataFrozen events. The other six events
// (Staked, ResolvedFriendly, ResolvedOpenVote, DistributedPrizePool,
// Canceled, Claimed) are no-op in 2B-2 — 2B-3 and 2B-4 extend the
// dispatcher in place.
//
// runIndexerOnce orchestrates a single tick:
//   - Phase A: getLogs over a block-range chunk
//   - Phase B: multicall prefetch for synthetic-row metadata, batched
//     by prefetchBatchSize
//   - Phase C: per-chunk Postgres transaction with handler dispatch
//     plus an ownership-gated advance of pm_indexer_state.last_indexed_block
//
// The mutex is acquired/released via raw SQL keyed by a token
// (locked_at value), so a stale-recovered slow worker cannot clear or
// commit progress against a new owner's lock.
//
// See `%TEMP%/mako-private-markets-2B-2-plan.md` for the full design
// and the binding invariants. 9 rounds of Codex review converged here.
// ----------------------------------------------------------------------------

import { and, eq, sql } from 'drizzle-orm';
import type { PublicClient } from 'viem';

import type { DbOrTx } from '@/db/client';
import {
  pmIndexerState,
  pmMarkets,
  pmOptions,
  pmResolutions,
  pmStakes,
} from '@/db/schema';
import { privateMarketsAbi } from '@/lib/MakoPrivateMarketsV1.abi';

import { decodePrivateMarketsLogs, type DecodedEvent } from './event-decode';
import {
  bigintToNumber,
  bytesToUtf8,
  mapShapeEnum,
  normalizeHex,
  numberToBigInt,
  secondsBigIntToDate,
} from './normalize';
import { allocateSlug } from './slug';

// ---- Types -----------------------------------------------------------------

export interface RunIndexerArgs {
  chainId: number;
  contractAddress: `0x${string}`;
  /// Block at which the contract was deployed; lower bound on bootstrap.
  /// Bigint here because viem returns block numbers as bigint; downcast
  /// happens inside via bigintToNumber().
  deployBlock: bigint;
  /// Top-level Drizzle handle. The orchestrator opens a Phase C
  /// transaction on this; acquire/release run on the same handle
  /// outside the transaction.
  db: DbOrTx;
  publicClient: PublicClient;
  /// Block-range chunk size for getLogs. Default 5_000.
  chunkSize?: number;
  /// Cap on MarketCreated events per Phase B multicall request.
  /// Default 50. Independent of chunkSize.
  prefetchBatchSize?: number;
  /// Stale lock auto-release threshold. Default 5 minutes.
  mutexStaleAfterMs?: number;
}

export type RunIndexerResult =
  | RunIndexerResultProcessed
  | RunIndexerResultBusy;

export interface RunIndexerResultProcessed {
  chainId: number;
  mutex: 'acquired' | 'stale-recovered';
  fromBlock: number;
  toBlock: number;
  decodedEventCount: number;
  marketsWritten: number;
  /// Codex round-2 m1: a release failure on the success path leaves
  /// the lock held until stale-recovery (5 min default). Surfacing
  /// the warning here lets ops alert on stuck locks rather than
  /// treating the run as cleanly successful. Empty/undefined ⇒
  /// release succeeded.
  releaseWarning?: string;
}

export interface RunIndexerResultBusy {
  chainId: number;
  mutex: 'busy';
  fromBlock: null;
  toBlock: null;
  decodedEventCount: 0;
  marketsWritten: 0;
}

export function isBusy(r: RunIndexerResult): r is RunIndexerResultBusy {
  return r.mutex === 'busy';
}

// Pure Solidity MarketView struct shape, as viem decodes it.
export interface MarketViewLike {
  creator: `0x${string}`;
  shape: number;
  clientNonce: `0x${string}`;
  createdAt: bigint;
  stakingOpensAt: bigint;
  closeAt: bigint;
  viewMode: number;
  participationMode: number;
  storedState: number;
  effectiveState: number;
  perStakeMin: bigint;
  perStakeMax: bigint;
  perWalletCumulativeMax: bigint;
  fixedStake: bigint;
  winnersCount: number;
  totalStake: bigint;
  friendlyOutcome: number;
  friendlyEmptyPoolPath: boolean;
  feeTaken: bigint;
  dust: bigint;
  metadataFrozenEmitted: boolean;
}

export interface PrefetchedMetadata {
  market: MarketViewLike;
  title: { value: string; ok: boolean };
  description: { value: string; ok: boolean };
  streamUrl: { value: string; ok: boolean };
  optionLabels: Array<{ value: string; ok: boolean }>;
  allowlist: `0x${string}`[];
  participants: `0x${string}`[];
}

export interface HandlerCtx {
  /// Phase C transaction client. All DB work in handlers must go
  /// through this so the chunk's writes commit/rollback atomically.
  chunkTx: DbOrTx;
  chainId: number;
  /// Pre-normalized lowercase. The orchestrator normalises at entry.
  contractAddress: `0x${string}`;
  /// Lock token threaded into the Phase C ownership-gated UPDATE.
  acquiredLockedAt: Date;
  /// Phase B output, keyed by marketId-as-number. Populated for
  /// every MarketCreated event in the chunk regardless of whether
  /// the handler ends up consuming it (synthetic-insert path) or
  /// not (confirmed-flip path).
  prefetch: Map<number, PrefetchedMetadata>;
  /// 2B-3 addition: per-(marketId, optionIndex)
  /// `getOptionFirstStakeSequence` reads, populated by Phase B for
  /// every Staked event in the chunk. Key format
  /// `${marketId}:${optionIndex}` (both as numbers). Optional so
  /// 2B-2 callers (and tests that only exercise MarketCreated /
  /// MarketMetadataFrozen) can omit it without breaking.
  firstStakeSequence?: Map<
    string,
    { sequence: number; isSet: boolean }
  >;
}

export class StaleLockLostError extends Error {
  constructor(public readonly chainId: number) {
    super(
      `Phase C lost the lock on chain ${chainId} (stale-recovered by another worker); rolling back chunk`,
    );
    this.name = 'StaleLockLostError';
  }
}

// ---- Mutex SQL -------------------------------------------------------------

interface AcquireRow {
  lastIndexedBlock: number;
  newContractAddress: string;
  acquiredLockedAt: Date;
  priorContractAddress: string | null;
  inserted: boolean;
  mutexOutcome: 'acquired' | 'stale-recovered';
}

// pglite's `db.execute(sql\`...\`)` returns timestamp columns as raw
// strings ('2026-05-09 19:02:48.49+01'); postgres-js's `.execute()`
// auto-converts them to Date. Normalize in JS so both adapters
// produce the same Date-shape AcquireRow.
function coerceAcquireDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) {
      throw new Error(
        `coerceAcquireDate: unparseable timestamp string: ${value}`,
      );
    }
    return d;
  }
  throw new Error(
    `coerceAcquireDate: unexpected timestamp shape: ${typeof value}`,
  );
}

export async function acquireMutex(
  db: DbOrTx,
  chainId: number,
  contractAddressLower: string,
  staleMs: number,
): Promise<AcquireRow[]> {
  // Single CTE statement: prior snapshot, conditional upsert, derived
  // mutex_outcome. See the plan's "Bootstrap-and-mutex" section for the
  // rationale (R5-M1 → R7-M2). All locked_at writes are
  // date_trunc('milliseconds', now()) so the JS Date round-trips
  // losslessly when used as a token.
  const result = await db.execute(sql`
    WITH prior AS (
      SELECT chain_id,
             contract_address AS prior_contract_address,
             locked_at        AS prior_locked_at
        FROM pm_indexer_state
       WHERE chain_id = ${chainId}
    ),
    upserted AS (
      INSERT INTO pm_indexer_state
            (chain_id, contract_address, last_indexed_block, locked_at,                          updated_at)
      VALUES (${chainId}, ${contractAddressLower}, 0,
              date_trunc('milliseconds', now()), now())
      ON CONFLICT (chain_id) DO UPDATE SET
        locked_at  = date_trunc('milliseconds', now()),
        updated_at = now()
      WHERE pm_indexer_state.locked_at IS NULL
         OR pm_indexer_state.locked_at < (now() - make_interval(secs => ${staleMs}::numeric / 1000))
      RETURNING
        chain_id,
        contract_address,
        last_indexed_block,
        locked_at,
        (xmax = 0) AS inserted
    )
    SELECT
      u.last_indexed_block AS "lastIndexedBlock",
      u.contract_address   AS "newContractAddress",
      u.locked_at          AS "acquiredLockedAt",
      p.prior_contract_address AS "priorContractAddress",
      u.inserted           AS "inserted",
      CASE
        WHEN u.inserted                      THEN 'acquired'
        WHEN p.prior_locked_at IS NOT NULL   THEN 'stale-recovered'
        ELSE                                      'acquired'
      END                  AS "mutexOutcome"
    FROM upserted u
    LEFT JOIN prior p ON p.chain_id = u.chain_id;
  `);
  // Both adapters expose row arrays; pglite wraps them in `{ rows }`.
  const raw =
    (result as unknown as { rows?: unknown[] }).rows ??
    (result as unknown as unknown[]);
  return (raw as Record<string, unknown>[]).map((r) => ({
    lastIndexedBlock: Number(r.lastIndexedBlock),
    newContractAddress: String(r.newContractAddress),
    acquiredLockedAt: coerceAcquireDate(r.acquiredLockedAt),
    priorContractAddress:
      r.priorContractAddress === null || r.priorContractAddress === undefined
        ? null
        : String(r.priorContractAddress),
    inserted: Boolean(r.inserted),
    mutexOutcome: r.mutexOutcome as 'acquired' | 'stale-recovered',
  }));
}

async function releaseMutex(
  db: DbOrTx,
  chainId: number,
  acquiredLockedAt: Date,
): Promise<void> {
  // Token-scoped release. If the token doesn't match (i.e., we lost
  // the lock to a stale-recovery), zero rows update — that's fine,
  // the new owner's lock stays intact. Use the Drizzle update builder
  // so the call is adapter-agnostic (postgres-js + pglite both
  // supported via the same surface).
  await db
    .update(pmIndexerState)
    .set({ lockedAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(pmIndexerState.chainId, chainId),
        eq(pmIndexerState.lockedAt, acquiredLockedAt),
      ),
    );
}

async function advanceLastIndexedBlockOrThrow(
  chunkTx: DbOrTx,
  chainId: number,
  acquiredLockedAt: Date,
  endOfChunk: number,
): Promise<void> {
  // Phase C ownership-gated advance. If the lock has been
  // stale-recovered out from under us, this matches 0 rows — throw to
  // roll back the whole chunk transaction (events + advance) in one
  // shot. Builder + RETURNING is adapter-agnostic — using
  // `(result as { count }).count` would have tied us to postgres-js's
  // RowList shape and broken under pglite tests.
  const advanced = await chunkTx
    .update(pmIndexerState)
    .set({ lastIndexedBlock: endOfChunk, updatedAt: new Date() })
    .where(
      and(
        eq(pmIndexerState.chainId, chainId),
        eq(pmIndexerState.lockedAt, acquiredLockedAt),
      ),
    )
    .returning({ chainId: pmIndexerState.chainId });
  if (advanced.length === 0) {
    throw new StaleLockLostError(chainId);
  }
}

// ---- Handlers --------------------------------------------------------------

function isUniqueViolationOn(err: unknown, constraintName: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; constraint_name?: string };
  return e.code === '23505' && e.constraint_name === constraintName;
}

export async function processMarketCreated(
  ctx: HandlerCtx,
  event: Extract<DecodedEvent, { eventName: 'MarketCreated' }>,
): Promise<{
  outcome: 'confirmed' | 'synthetic-inserted' | 'replay-noop';
}> {
  const { chainId, contractAddress, chunkTx, prefetch } = ctx;
  const marketIdNum = bigintToNumber(event.args.marketId);
  const creatorLower = normalizeHex(event.args.creator, 20);
  const clientNonceLower = normalizeHex(event.args.clientNonce, 32);

  // Confirmed-flip path: try UPDATE first. The WHERE clause's
  // creator-AND-clientNonce-AND-pending predicate is the same-nonce-
  // hijack defense from parent plan round 8. Also scope by chainId +
  // contractAddress (Codex round-1 M1) — the partial unique index on
  // client_nonce only constrains pending rows by nonce, not by chain
  // or contract, so without these clauses a redeploy or future
  // multi-contract context could bind a pending row from the wrong
  // chain/contract.
  const flipResult = await chunkTx
    .update(pmMarkets)
    .set({
      marketId: marketIdNum,
      createStatus: 'confirmed',
      confirmedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(pmMarkets.chainId, chainId),
        eq(pmMarkets.contractAddress, contractAddress),
        eq(pmMarkets.clientNonce, clientNonceLower),
        eq(pmMarkets.creator, creatorLower),
        eq(pmMarkets.createStatus, 'pending'),
      ),
    )
    .returning({ id: pmMarkets.id });

  if (flipResult.length > 0) {
    // R4-M2: confirmed-flip does NOT consume prefetch. Canonical
    // metadata refresh on confirmed rows is deferred to 2B-5's
    // resnapshot sweep.
    return { outcome: 'confirmed' };
  }

  // Synthetic-insert path. R5-M3: existence pre-check FIRST, before
  // any prefetch lookup. Replays of already-confirmed markets must
  // not require metadata.
  const existing = await chunkTx
    .select({ id: pmMarkets.id })
    .from(pmMarkets)
    .where(
      and(
        eq(pmMarkets.chainId, chainId),
        eq(pmMarkets.contractAddress, contractAddress),
        eq(pmMarkets.marketId, marketIdNum),
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    return { outcome: 'replay-noop' };
  }

  const meta = prefetch.get(marketIdNum);
  if (!meta) {
    throw new Error(
      `processMarketCreated: prefetch missing marketId=${marketIdNum} ` +
        `for chainId=${chainId} contract=${contractAddress}; ` +
        `Phase B should have populated it`,
    );
  }

  const slug = await allocateSlug(chunkTx, { syntheticDxRow: true });
  const stakingOpensAt = secondsBigIntToDate(event.args.stakingOpensAt);
  const closeAt = secondsBigIntToDate(event.args.closeAt);
  const isPrizePool = event.args.marketShape === 2;

  try {
    const inserted = await chunkTx
      .insert(pmMarkets)
      .values({
        chainId,
        contractAddress,
        slug,
        clientNonce: clientNonceLower,
        marketId: marketIdNum,
        creator: creatorLower,
        shape: mapShapeEnum(event.args.marketShape),
        createStatus: 'confirmed',
        confirmedAt: new Date(),
        title: meta.title.value,
        description: meta.description.value,
        streamUrl: meta.streamUrl.value,
        visibilityView: event.args.visibilityView,
        visibilityParticipation: event.args.visibilityParticipation,
        stakingOpensAt,
        closeAt,
        perStakeMin: meta.market.perStakeMin.toString(),
        perStakeMax: meta.market.perStakeMax.toString(),
        perWalletCumulativeMax: meta.market.perWalletCumulativeMax.toString(),
        fixedStake: meta.market.fixedStake.toString(),
        winnersCount: meta.market.winnersCount,
        currentState: 'created',
        friendlyOutcome:
          meta.market.friendlyOutcome === 0 || meta.market.friendlyOutcome === 1
            ? meta.market.friendlyOutcome
            : null,
        friendlyEmptyPoolPath: meta.market.friendlyEmptyPoolPath,
        feeTaken: meta.market.feeTaken.toString(),
        dust: meta.market.dust.toString(),
        totalStake: meta.market.totalStake.toString(),
      })
      .returning({ id: pmMarkets.id });

    const marketDbId = inserted[0]!.id;

    // pm_options rows: one per optionLabel. participantWallet only
    // populated for Prize Pool markets where the participants array
    // has an entry at the matching index.
    const optionRows = meta.optionLabels.map((labelResult, idx) => ({
      marketDbId,
      optionIndex: idx,
      label: labelResult.value,
      participantWallet:
        isPrizePool && meta.participants[idx]
          ? normalizeHex(meta.participants[idx], 20)
          : null,
      poolTotal: '0',
      firstStakeSequence: null,
    }));
    if (optionRows.length > 0) {
      await chunkTx.insert(pmOptions).values(optionRows);
    }

    return { outcome: 'synthetic-inserted' };
  } catch (err: unknown) {
    // Two-layer guard: pre-check above is the common path; this catch
    // covers the rare race where a concurrent insert (e.g. stale-lock
    // recovery) lands a matching row between our SELECT and INSERT.
    if (isUniqueViolationOn(err, 'pm_markets_chain_market_id_uniq')) {
      return { outcome: 'replay-noop' };
    }
    throw err;
  }
}

export async function processMarketMetadataFrozen(
  ctx: HandlerCtx,
  event: Extract<DecodedEvent, { eventName: 'MarketMetadataFrozen' }>,
): Promise<{ outcome: 'frozen' | 'replay-noop' | 'orphan-event' }> {
  const { chainId, contractAddress, chunkTx } = ctx;
  const marketIdNum = bigintToNumber(event.args.marketId);
  const txHashLower = normalizeHex(
    event.log.transactionHash as `0x${string}`,
    32,
  );
  const blockNumberNum = bigintToNumber(event.log.blockNumber as bigint);
  // Per the "event-arg-as-block-timestamp" rule (R3-M2): frozenAt
  // equals block.timestamp at emission by contract design.
  const blockTimestamp = secondsBigIntToDate(event.args.frozenAt);
  const logIndex = event.log.logIndex as number;

  // Step 1: pm_resolutions INSERT keyed by (tx_hash, log_index).
  // ON CONFLICT DO NOTHING + RETURNING txHash gives us the
  // first-write signal.
  const insertResult = await chunkTx
    .insert(pmResolutions)
    .values({
      chainId,
      contractAddress,
      txHash: txHashLower,
      logIndex,
      marketId: marketIdNum,
      eventName: 'MarketMetadataFrozen',
      payload: { frozenAt: event.args.frozenAt.toString() },
      blockNumber: blockNumberNum,
      blockTimestamp,
    })
    .onConflictDoNothing({
      target: [pmResolutions.txHash, pmResolutions.logIndex],
    })
    .returning({ txHash: pmResolutions.txHash });

  if (insertResult.length === 0) {
    // R8-m2: replay-noop short-circuits BEFORE any mirror lookup.
    return { outcome: 'replay-noop' };
  }

  // Step 2: mirror frozen_at into pm_markets, first-write-only.
  const existing = await chunkTx
    .select({ id: pmMarkets.id, frozenAt: pmMarkets.frozenAt })
    .from(pmMarkets)
    .where(
      and(
        eq(pmMarkets.chainId, chainId),
        eq(pmMarkets.contractAddress, contractAddress),
        eq(pmMarkets.marketId, marketIdNum),
      ),
    )
    .limit(1);

  if (existing.length === 0) {
    // pm_resolutions row already inserted for audit; the pm_markets
    // row will be picked up by 2B-5's resnapshot sweep when it lands
    // (or never, for genuine direct-contract orphans).
    // eslint-disable-next-line no-console
    console.warn(
      `processMarketMetadataFrozen: orphan event for marketId=${marketIdNum} ` +
        `on chainId=${chainId} contract=${contractAddress}; ` +
        `pm_resolutions recorded, mirror skipped`,
    );
    return { outcome: 'orphan-event' };
  }

  if (existing[0].frozenAt !== null) {
    // First-write-only. 2B-5's resnapshot sweep owns later updates.
    return { outcome: 'frozen' };
  }

  await chunkTx
    .update(pmMarkets)
    .set({ frozenAt: blockTimestamp, updatedAt: new Date() })
    .where(eq(pmMarkets.id, existing[0].id));

  return { outcome: 'frozen' };
}

/// 2B-3: Staked event handler. Per the parent plan, every event-table
/// row is keyed by (tx_hash, log_index) and the dependent aggregates
/// (pool_total, first_stake_sequence) are mutated ONLY on the first
/// successful insert — replays MUST NOT double-count.
///
/// Steps:
///   1. INSERT pm_stakes row with ON CONFLICT (tx_hash, log_index)
///      DO NOTHING RETURNING. RETURNING empty → `replay-noop`.
///   2. Look up the pm_markets row by (chainId, contractAddress,
///      marketId) to get the uuid for pm_options.market_db_id. If
///      the row is missing (cross-chunk ordering between
///      MarketCreated and Staked when starting mid-history), record
///      the stake for audit and return `inserted` with a soft warn —
///      pool_total + first_stake_sequence reconcile via 2B-5's
///      resnapshot sweep.
///   3. Atomically increment pm_options.pool_total by amount.
///   4. First-stake-sequence: read the prefetched
///      `getOptionFirstStakeSequence(marketId, optionIndex)` from
///      `ctx.firstStakeSequence`. If `isSet=true` AND the local row
///      is currently NULL, write the sequence. Read-once-and-set —
///      never overwritten.
export async function processStaked(
  ctx: HandlerCtx,
  event: Extract<DecodedEvent, { eventName: 'Staked' }>,
): Promise<{ outcome: 'inserted' | 'replay-noop' | 'orphan-event' }> {
  const { chainId, contractAddress, chunkTx, firstStakeSequence } = ctx;
  const marketIdNum = bigintToNumber(event.args.marketId);
  // optionIndex on the Staked event is uint256 in the ABI but bounded
  // to MAX_OPTIONS (≤10) at the contract level. bigintToNumber's
  // safe-integer guard catches any drift.
  const optionIndex = bigintToNumber(event.args.optionIndex);
  const stakerLower = normalizeHex(event.args.staker, 20);
  const txHashLower = normalizeHex(
    event.log.transactionHash as `0x${string}`,
    32,
  );
  const logIndex = event.log.logIndex as number;
  const blockNumber = bigintToNumber(event.log.blockNumber as bigint);
  // "event-arg-as-block-timestamp" rule (R3-M2): the contract emits
  // Staked.timestamp = block.timestamp at emission.
  const blockTimestamp = secondsBigIntToDate(event.args.timestamp);
  const amount = event.args.amount.toString();

  // Step 1: ON CONFLICT (tx_hash, log_index) DO NOTHING RETURNING.
  const insertResult = await chunkTx
    .insert(pmStakes)
    .values({
      chainId,
      contractAddress,
      txHash: txHashLower,
      logIndex,
      marketId: marketIdNum,
      staker: stakerLower,
      optionIndex,
      amount,
      blockNumber,
      blockTimestamp,
    })
    .onConflictDoNothing({
      target: [pmStakes.txHash, pmStakes.logIndex],
    })
    .returning({ txHash: pmStakes.txHash });

  if (insertResult.length === 0) {
    // Replay path — pool_total + first_stake_sequence already
    // updated on the original insert. No further work.
    return { outcome: 'replay-noop' };
  }

  // Step 2: resolve pm_options.market_db_id via pm_markets lookup.
  const marketRow = await chunkTx
    .select({ id: pmMarkets.id })
    .from(pmMarkets)
    .where(
      and(
        eq(pmMarkets.chainId, chainId),
        eq(pmMarkets.contractAddress, contractAddress),
        eq(pmMarkets.marketId, marketIdNum),
      ),
    )
    .limit(1);

  if (marketRow.length === 0) {
    // Cross-chunk ordering can land Staked before MarketCreated when
    // starting mid-history (e.g. backfill from genesis). pm_stakes
    // row already inserted for audit; pool_total + sequence mirror
    // skipped. 2B-5's resnapshot sweep is the authoritative path.
    // eslint-disable-next-line no-console
    console.warn(
      `processStaked: orphan stake for marketId=${marketIdNum} ` +
        `optionIndex=${optionIndex} on chainId=${chainId} ` +
        `contract=${contractAddress}; pm_stakes recorded, ` +
        `pool_total / first_stake_sequence mirror skipped`,
    );
    return { outcome: 'orphan-event' };
  }

  const marketDbId = marketRow[0].id;

  // Step 3: atomic pool_total increment. The chunkTx transaction
  // makes this commit-or-rollback together with the pm_stakes
  // insert from step 1.
  await chunkTx
    .update(pmOptions)
    .set({ poolTotal: sql`${pmOptions.poolTotal} + ${amount}` })
    .where(
      and(
        eq(pmOptions.marketDbId, marketDbId),
        eq(pmOptions.optionIndex, optionIndex),
      ),
    );

  // Step 4: first-stake-sequence write. Predicate on
  // `firstStakeSequence IS NULL` makes the update idempotent against
  // any race that the mutex doesn't already foreclose. Skipped
  // entirely when prefetch reports `isSet=false` (defensive — the
  // contract returns `(_, false)` when no stake has ever been
  // recorded for the (marketId, optionIndex), which would be a
  // logic bug for a Staked event we just observed).
  const fssEntry = firstStakeSequence?.get(`${marketIdNum}:${optionIndex}`);
  if (fssEntry?.isSet) {
    await chunkTx
      .update(pmOptions)
      .set({ firstStakeSequence: fssEntry.sequence })
      .where(
        and(
          eq(pmOptions.marketDbId, marketDbId),
          eq(pmOptions.optionIndex, optionIndex),
          sql`${pmOptions.firstStakeSequence} IS NULL`,
        ),
      );
  }

  return { outcome: 'inserted' };
}

// ---- Orchestrator ----------------------------------------------------------

export async function runIndexerOnce(
  args: RunIndexerArgs,
): Promise<RunIndexerResult> {
  // R9-m3: validate numeric args BEFORE acquiring the mutex.
  const chunkSize = args.chunkSize ?? 5_000;
  const prefetchBatchSize = args.prefetchBatchSize ?? 50;
  const mutexStaleAfterMs = args.mutexStaleAfterMs ?? 5 * 60 * 1000;
  for (const [name, val] of [
    ['chunkSize', chunkSize],
    ['prefetchBatchSize', prefetchBatchSize],
    ['mutexStaleAfterMs', mutexStaleAfterMs],
  ] as const) {
    if (
      !Number.isInteger(val) ||
      val <= 0 ||
      val > Number.MAX_SAFE_INTEGER
    ) {
      throw new RangeError(
        `runIndexerOnce: ${name} must be a positive safe integer; got ${val}`,
      );
    }
  }

  const { chainId, deployBlock, db: coordinationDb, publicClient } = args;
  const contractAddressLower = normalizeHex(args.contractAddress, 20);

  const acquireRows = await acquireMutex(
    coordinationDb,
    chainId,
    contractAddressLower,
    mutexStaleAfterMs,
  );

  // R6-M2: ONLY the busy short-circuit returns before the try.
  if (acquireRows.length === 0) {
    return {
      chainId,
      mutex: 'busy',
      fromBlock: null,
      toBlock: null,
      decodedEventCount: 0,
      marketsWritten: 0,
    };
  }

  const {
    lastIndexedBlock,
    inserted,
    mutexOutcome,
    priorContractAddress,
    acquiredLockedAt,
  } = acquireRows[0];

  let totalDecodedEvents = 0;
  let totalMarketsWritten = 0;
  let actualFromBlock = 0;
  let actualToBlock = 0;
  let releaseWarning: string | undefined;

  let processedResult: RunIndexerResultProcessed | undefined;

  try {
    // Contract-address mismatch guard: redeploying the contract to the
    // same chain without resetting pm_indexer_state would silently
    // index logs from the wrong contract. Throw with the documented
    // reset SQL in the message.
    if (
      !inserted &&
      priorContractAddress !== null &&
      priorContractAddress !== contractAddressLower
    ) {
      throw new Error(
        `pm_indexer_state row for chain ${chainId} has ` +
          `contract_address=${priorContractAddress} but call passed ` +
          `${contractAddressLower}; manual reset required ` +
          `(DELETE FROM pm_indexer_state WHERE chain_id = ${chainId})`,
      );
    }

    const deployBlockNum = bigintToNumber(deployBlock);
    const fromBlock =
      inserted || lastIndexedBlock === 0
        ? deployBlockNum
        : Math.max(deployBlockNum, lastIndexedBlock - 11);
    const chainHead = bigintToNumber(await publicClient.getBlockNumber());

    actualFromBlock = fromBlock;
    actualToBlock = Math.min(fromBlock - 1, chainHead);

    if (fromBlock > chainHead) {
      // Already at or past head; nothing to do this tick.
      processedResult = {
        chainId,
        mutex: mutexOutcome,
        fromBlock,
        toBlock: chainHead,
        decodedEventCount: 0,
        marketsWritten: 0,
      };
    } else {

    let cursor = fromBlock;
    while (cursor <= chainHead) {
      const chunkEnd = Math.min(cursor + chunkSize - 1, chainHead);

      // Phase A: getLogs (RPC, no DB).
      const logs = await publicClient.getLogs({
        address: contractAddressLower as `0x${string}`,
        fromBlock: numberToBigInt(cursor),
        toBlock: numberToBigInt(chunkEnd),
      });

      const decoded = decodePrivateMarketsLogs(logs);
      totalDecodedEvents += decoded.length;

      // Phase B: multicall prefetch for MarketCreated events,
      // batched by prefetchBatchSize. Independent of chunkSize.
      const marketCreatedEvents = decoded.filter(
        (
          e,
        ): e is Extract<DecodedEvent, { eventName: 'MarketCreated' }> =>
          e.eventName === 'MarketCreated',
      );
      const prefetch = new Map<number, PrefetchedMetadata>();

      for (
        let i = 0;
        i < marketCreatedEvents.length;
        i += prefetchBatchSize
      ) {
        const batch = marketCreatedEvents.slice(i, i + prefetchBatchSize);
        const contracts = batch.flatMap((ev) => {
          const mid = ev.args.marketId;
          return [
            {
              address: contractAddressLower as `0x${string}`,
              abi: privateMarketsAbi,
              functionName: 'getMarket' as const,
              args: [mid] as const,
            },
            {
              address: contractAddressLower as `0x${string}`,
              abi: privateMarketsAbi,
              functionName: 'getMarketTitle' as const,
              args: [mid] as const,
            },
            {
              address: contractAddressLower as `0x${string}`,
              abi: privateMarketsAbi,
              functionName: 'getMarketDescription' as const,
              args: [mid] as const,
            },
            {
              address: contractAddressLower as `0x${string}`,
              abi: privateMarketsAbi,
              functionName: 'getMarketStreamUrl' as const,
              args: [mid] as const,
            },
            {
              address: contractAddressLower as `0x${string}`,
              abi: privateMarketsAbi,
              functionName: 'getMarketOptions' as const,
              args: [mid] as const,
            },
            {
              address: contractAddressLower as `0x${string}`,
              abi: privateMarketsAbi,
              functionName: 'getMarketAllowlist' as const,
              args: [mid] as const,
            },
            {
              address: contractAddressLower as `0x${string}`,
              abi: privateMarketsAbi,
              functionName: 'getMarketParticipants' as const,
              args: [mid] as const,
            },
          ];
        });

        // allowFailure: false → any sub-revert throws and aborts the
        // chunk. Surrounding try/finally clears the mutex.
        const results = (await publicClient.multicall({
          allowFailure: false,
          contracts: contracts as never,
        })) as readonly unknown[];

        for (let j = 0; j < batch.length; j++) {
          const ev = batch[j];
          const base = j * 7;
          const market = results[base] as MarketViewLike;
          const titleBytes = results[base + 1] as `0x${string}`;
          const descBytes = results[base + 2] as `0x${string}`;
          const streamBytes = results[base + 3] as `0x${string}`;
          const optionLabelBytes = results[base + 4] as readonly `0x${string}`[];
          const allowlist = results[base + 5] as readonly `0x${string}`[];
          const participants = results[base + 6] as readonly `0x${string}`[];

          prefetch.set(bigintToNumber(ev.args.marketId), {
            market,
            title: bytesToUtf8(titleBytes),
            description: bytesToUtf8(descBytes),
            streamUrl: bytesToUtf8(streamBytes),
            optionLabels: optionLabelBytes.map(bytesToUtf8),
            allowlist: allowlist.map((a) => normalizeHex(a, 20)),
            participants: participants.map((a) => normalizeHex(a, 20)),
          });
        }
      }

      // 2B-3 Phase B addition: prefetch
      // `getOptionFirstStakeSequence(marketId, optionIndex)` for every
      // Staked event. Returned tuple is `(sequence: uint16,
      // isSet: bool)`. The handler writes this back into pm_options
      // only on the FIRST stake for that (market, option) — subsequent
      // stakes' wasted multicall reads are cheap and bounded.
      // Same prefetchBatchSize cap so a busy block can't blow up
      // the multicall payload.
      const stakedEvents = decoded.filter(
        (
          e,
        ): e is Extract<DecodedEvent, { eventName: 'Staked' }> =>
          e.eventName === 'Staked',
      );
      const firstStakeSequence = new Map<
        string,
        { sequence: number; isSet: boolean }
      >();

      for (
        let i = 0;
        i < stakedEvents.length;
        i += prefetchBatchSize
      ) {
        const batch = stakedEvents.slice(i, i + prefetchBatchSize);
        const contracts = batch.map((ev) => ({
          address: contractAddressLower as `0x${string}`,
          abi: privateMarketsAbi,
          functionName: 'getOptionFirstStakeSequence' as const,
          args: [ev.args.marketId, ev.args.optionIndex] as const,
        }));

        const results = (await publicClient.multicall({
          allowFailure: false,
          contracts: contracts as never,
        })) as readonly unknown[];

        for (let j = 0; j < batch.length; j++) {
          const ev = batch[j];
          // viem decodes a uint16 + bool tuple as
          // `readonly [number, boolean]`.
          const tuple = results[j] as readonly [number, boolean];
          const sequence = tuple[0];
          const isSet = tuple[1];
          const key =
            `${bigintToNumber(ev.args.marketId)}:${bigintToNumber(ev.args.optionIndex)}`;
          firstStakeSequence.set(key, { sequence, isSet });
        }
      }

      // Phase C: per-chunk transaction. Includes handler dispatch +
      // ownership-gated last_indexed_block advance.
      let chunkMarketsWritten = 0;
      // Drizzle's `transaction` accepts both plain db and tx clients
      // (savepoints), but at runtime we always pass the top-level
      // coordinationDb here.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (coordinationDb as any).transaction(async (chunkTx: DbOrTx) => {
        const ctx: HandlerCtx = {
          chunkTx,
          chainId,
          contractAddress: contractAddressLower,
          acquiredLockedAt,
          prefetch,
          firstStakeSequence,
        };

        for (const event of decoded) {
          if (event.eventName === 'MarketCreated') {
            const r = await processMarketCreated(ctx, event);
            if (
              r.outcome === 'confirmed' ||
              r.outcome === 'synthetic-inserted'
            ) {
              chunkMarketsWritten += 1;
            }
          } else if (event.eventName === 'MarketMetadataFrozen') {
            await processMarketMetadataFrozen(ctx, event);
          } else if (event.eventName === 'Staked') {
            await processStaked(ctx, event);
          }
          // Other event branches are 2B-4. No-op in 2B-3.
        }

        await advanceLastIndexedBlockOrThrow(
          chunkTx,
          chainId,
          acquiredLockedAt,
          chunkEnd,
        );
      });

      totalMarketsWritten += chunkMarketsWritten;
      cursor = chunkEnd + 1;
      actualToBlock = chunkEnd;
    }

    processedResult = {
      chainId,
      mutex: mutexOutcome,
      fromBlock: actualFromBlock,
      toBlock: actualToBlock,
      decodedEventCount: totalDecodedEvents,
      marketsWritten: totalMarketsWritten,
    };
    } // close `else` (chainHead-not-reached branch)
  } finally {
    // R6-M3: release does ONE thing — clear the lock IFF this worker
    // still owns it. last_indexed_block advancement lives entirely in
    // Phase C.
    //
    // Codex round-1 m2: never let a release failure mask the original
    // error. If the try-block already threw, the in-flight error is
    // the one the caller needs to see; release errors get logged but
    // don't propagate.
    //
    // Codex round-2 m1: on the success path, surface release failures
    // via processedResult.releaseWarning so ops can alert on stuck
    // locks instead of treating the run as cleanly successful.
    try {
      await releaseMutex(coordinationDb, chainId, acquiredLockedAt);
    } catch (releaseErr) {
      const message =
        releaseErr instanceof Error
          ? releaseErr.message
          : String(releaseErr);
      // eslint-disable-next-line no-console
      console.error(
        `runIndexerOnce: releaseMutex failed for chainId=${chainId}; ` +
          `original error (if any) takes precedence`,
        releaseErr,
      );
      releaseWarning = `releaseMutex failed: ${message}`;
    }
  }

  // Only reachable on success (try/finally bubbled no error). If
  // release also failed, attach the warning so callers/monitoring
  // can detect stuck locks before stale-recovery clears them.
  if (releaseWarning && processedResult) {
    processedResult.releaseWarning = releaseWarning;
  }
  return processedResult!;
}
