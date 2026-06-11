// ----------------------------------------------------------------------------
// #186 Leaderboard — main-market event indexer.
//
// Scans the MAIN MakoMarketsV4 contract(s) in LEADERBOARD_CONTRACTS for
// BetPlaced / Claimed / CreatorFeePaid and appends raw rows to
// mako_market_events. The leaderboard aggregates the ledger at read time
// (queries.ts); nothing here keeps running totals.
//
// Structure mirrors the PM indexer (private-markets/indexer.ts) — CTE
// mutex with stale recovery, chunked getLogs, per-chunk Postgres
// transaction (inserts + ownership-gated cursor advance commit
// atomically) — with three deliberate divergences, all plan-reviewed:
//
//   1. CONFIRMATIONS horizon instead of overlap re-scan. The PM scanner
//      reads to chain head and re-scans an 11-block tail each tick; this
//      one never scans past (head − CONFIRMATIONS) and resumes at
//      cursor + 1. Reorg safety IS the confirmations depth — the
//      (tx_hash, log_index) PK is idempotency defense-in-depth, not the
//      mechanism. There is NO deletion path: a reorg deeper than
//      CONFIRMATIONS requires the manual re-sync runbook (truncate
//      mako_market_events + mako_leaderboard_indexer_state, re-run
//      scripts/seed-leaderboard.mts). For the same reason, RAISING
//      CONFIRMATIONS later does not retroactively re-validate
//      already-indexed blocks — that too is a re-sync, not an env bump.
//   2. Adaptive halve-on-error chunking. Monad's PUBLIC RPC caps
//      eth_getLogs at a 100-block range (-32614 — documented in
//      admin/analytics/route.ts); private RPCs allow 1k+. Rather than
//      fail the tick on a mis-sized chunk, fetchLogsAdaptive halves the
//      span (floor CHUNK_FLOOR) and retries. The PM scanner lacks this.
//   3. Multi-contract: one cursor row per (chain_id, contract_address),
//      scanned sequentially. No contract-mismatch guard needed — the PM
//      table keys by chain only; this one keys by (chain, contract).
//
// Cold start: the live v4 deploy block is ~weeks behind head on a
// sub-second chain — millions of blocks. No serverless tick can finish
// that, so the one-time scripts/seed-leaderboard.mts (local Node, no
// function timeout) backfills BEFORE the cron is deployed. Steady state
// after the seed is a few hundred blocks per 5-minute tick.
//
// Lock discipline: LEADERBOARD_STALE_LOCK_MS must exceed the cron
// route's maxDuration, or the next cron fire reclaims a live lock during
// a long tick and double-scans (idempotent, but churn exactly when the
// indexer is most loaded). The relationship is pinned by a unit test —
// see __tests__/indexer.test.ts.
// ----------------------------------------------------------------------------

import { parseAbiItem, type PublicClient } from 'viem';
import { sql, and, eq } from 'drizzle-orm';

import type { DbOrTx } from '@/db/client';
import {
  makoMarketEvents,
  makoLeaderboardIndexerState,
  type NewMakoMarketEvent,
} from '@/db/schema';
import { MONAD_TESTNET_ID } from '@/lib/chain';
import {
  normalizeHex,
  normalizeAddressLower,
  bigintToNumber,
  numberToBigInt,
} from '@/lib/private-markets/normalize';
import {
  LEADERBOARD_CONTRACTS,
  type LeaderboardContract,
} from './contracts';

// ---- Constants -------------------------------------------------------------

/// Reorg horizon. The indexer never scans within this many blocks of
/// head. 16 is comfortably above any observed Monad-testnet reorg
/// (fast-finality BFT); plan open-Q4 chose freshness over PM's 50.
export const LEADERBOARD_CONFIRMATIONS = 16;

/// Stale-lock auto-recovery threshold. MUST stay greater than
/// LEADERBOARD_CRON_MAX_DURATION_S * 1000 (unit-test-pinned) so a tick
/// running its full serverless window cannot have its lock reclaimed
/// mid-run by the next cron fire.
export const LEADERBOARD_STALE_LOCK_MS = 5 * 60 * 1000;

/// The cron route's `export const maxDuration` value, named here so the
/// route and the constant-relationship test share one source of truth.
/// 60s is within every Vercel tier's allowance.
export const LEADERBOARD_CRON_MAX_DURATION_S = 60;

/// Soft time budget for the cron path: stop starting new chunks this
/// many ms after entry so the tick releases its lock cleanly instead of
/// being killed at maxDuration and holding the lock until stale
/// recovery. Progress is kept — each chunk commits its own cursor
/// advance. The seed script omits the budget entirely (local Node has
/// no function timeout).
export const LEADERBOARD_CRON_TIME_BUDGET_MS =
  (LEADERBOARD_CRON_MAX_DURATION_S - 10) * 1000;

/// getLogs span floor for the adaptive halving. At 50 blocks even the
/// public RPC's 100-block cap has headroom; below this we rethrow.
const CHUNK_FLOOR = 50;

/// Default getLogs chunk span. The PUBLIC Monad RPC rejects >100; the
/// halve-on-error path would recover, but defaulting to the safe floor
/// avoids a guaranteed first-call failure when MONAD_RPC_URL is unset.
/// Operators with a private RPC bump via LEADERBOARD_LOG_CHUNK.
function defaultChunkSize(): number {
  const raw = process.env.LEADERBOARD_LOG_CHUNK;
  if (raw === undefined || raw.trim() === '') return 100;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < CHUNK_FLOOR) {
    throw new RangeError(
      `LEADERBOARD_LOG_CHUNK must be an integer >= ${CHUNK_FLOOR}; got ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

// ---- Event ABI -------------------------------------------------------------

/// The three per-user events the ledger ingests. NOTE: BetPlaced also
/// fires for the creator's seed bet at createMarket
/// (MakoMarketsV4.sol:433) — that is a real position and counts as
/// staked by design (plan: Codex r2 NIT-2).
const EVENT_BET_PLACED = parseAbiItem(
  'event BetPlaced(uint256 indexed id, address indexed user, bool isYes, uint256 amount)',
);
const EVENT_CLAIMED = parseAbiItem(
  'event Claimed(uint256 indexed id, address indexed user, uint256 amount)',
);
const EVENT_CREATOR_FEE_PAID = parseAbiItem(
  'event CreatorFeePaid(uint256 indexed id, address indexed creator, uint256 amount)',
);

const LEDGER_EVENTS = [
  EVENT_BET_PLACED,
  EVENT_CLAIMED,
  EVENT_CREATOR_FEE_PAID,
] as const;

// ---- Args / results --------------------------------------------------------

export interface RunLeaderboardIndexerArgs {
  /// Top-level Drizzle handle; per-chunk transactions open on this.
  db: DbOrTx;
  publicClient: PublicClient;
  /// Defaults to LEADERBOARD_CONTRACTS. Injectable for tests.
  contracts?: readonly LeaderboardContract[];
  chainId?: number;
  chunkSize?: number;
  confirmations?: number;
  staleLockMs?: number;
  /// Stop starting new chunks once this many ms have elapsed. Omit for
  /// no budget (seed script). The cron route passes
  /// LEADERBOARD_CRON_TIME_BUDGET_MS.
  timeBudgetMs?: number;
  /// Called after each committed chunk — the seed script's multi-hour
  /// backfill needs visible progress. No-op when omitted (cron path).
  onChunk?: (info: {
    contractAddress: `0x${string}`;
    chunkEnd: number;
    scanTarget: number;
    rowsInChunk: number;
  }) => void;
}

export interface LeaderboardContractScanResult {
  contractAddress: `0x${string}`;
  mutex: 'acquired' | 'stale-recovered' | 'busy';
  /// First block this run scanned (null when busy or already at head).
  fromBlock: number | null;
  /// Last block the cursor advanced to (null when busy; unchanged
  /// cursor when already at head).
  scannedTo: number | null;
  /// head − confirmations at run entry; the scan target.
  scanTarget: number | null;
  eventsInserted: number;
  /// True when the cursor reached scanTarget this run.
  upToDate: boolean;
  /// True when the time budget expired before reaching scanTarget.
  budgetExhausted: boolean;
  /// Non-empty when the success-path lock release failed (lock then
  /// self-heals via stale recovery). Mirrors the PM pattern.
  releaseWarning?: string;
}

export interface RunLeaderboardIndexerResult {
  chainId: number;
  contracts: LeaderboardContractScanResult[];
}

export class LeaderboardStaleLockLostError extends Error {
  constructor(contractAddress: string) {
    super(
      `leaderboard indexer lost the lock for ${contractAddress} ` +
        '(stale-recovered by another worker); rolling back chunk',
    );
    this.name = 'LeaderboardStaleLockLostError';
  }
}

// ---- Mutex -----------------------------------------------------------------

interface AcquireRow {
  lastScannedBlock: number;
  acquiredLockedAt: Date;
  inserted: boolean;
  mutexOutcome: 'acquired' | 'stale-recovered';
}

// pglite returns timestamps as raw strings; postgres-js returns Date.
// Same normalization the PM indexer ships.
function coerceDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) {
      throw new Error(`coerceDate: unparseable timestamp string: ${value}`);
    }
    return d;
  }
  throw new Error(`coerceDate: unexpected timestamp shape: ${typeof value}`);
}

async function acquireContractMutex(
  db: DbOrTx,
  chainId: number,
  contractAddressLower: string,
  staleMs: number,
): Promise<AcquireRow | null> {
  // Single CTE: prior snapshot + conditional upsert keyed by
  // (chain_id, contract_address). locked_at writes are ms-truncated so
  // the JS Date token round-trips losslessly (PM precedent).
  const result = await db.execute(sql`
    WITH prior AS (
      SELECT chain_id,
             locked_at AS prior_locked_at
        FROM mako_leaderboard_indexer_state
       WHERE chain_id = ${chainId}
         AND contract_address = ${contractAddressLower}
    ),
    upserted AS (
      INSERT INTO mako_leaderboard_indexer_state
            (chain_id, contract_address, last_scanned_block, locked_at, updated_at)
      VALUES (${chainId}, ${contractAddressLower}, 0,
              date_trunc('milliseconds', now()), now())
      ON CONFLICT (chain_id, contract_address) DO UPDATE SET
        locked_at  = date_trunc('milliseconds', now()),
        updated_at = now()
      WHERE mako_leaderboard_indexer_state.locked_at IS NULL
         OR mako_leaderboard_indexer_state.locked_at
            < (now() - make_interval(secs => ${staleMs}::numeric / 1000))
      RETURNING
        last_scanned_block,
        locked_at,
        (xmax = 0) AS inserted
    )
    SELECT
      u.last_scanned_block AS "lastScannedBlock",
      u.locked_at          AS "acquiredLockedAt",
      u.inserted           AS "inserted",
      CASE
        WHEN u.inserted                    THEN 'acquired'
        WHEN p.prior_locked_at IS NOT NULL THEN 'stale-recovered'
        ELSE                                    'acquired'
      END                  AS "mutexOutcome"
    FROM upserted u
    LEFT JOIN prior p ON true;
  `);
  const raw =
    (result as unknown as { rows?: unknown[] }).rows ??
    (result as unknown as unknown[]);
  const rows = raw as Record<string, unknown>[];
  if (rows.length === 0) return null; // busy
  const r = rows[0];
  return {
    lastScannedBlock: Number(r.lastScannedBlock),
    acquiredLockedAt: coerceDate(r.acquiredLockedAt),
    inserted: Boolean(r.inserted),
    mutexOutcome: r.mutexOutcome as 'acquired' | 'stale-recovered',
  };
}

async function releaseContractMutex(
  db: DbOrTx,
  chainId: number,
  contractAddressLower: string,
  acquiredLockedAt: Date,
): Promise<void> {
  // Token-scoped: zero rows updated when the lock was stale-recovered
  // away — the new owner's lock stays intact.
  await db
    .update(makoLeaderboardIndexerState)
    .set({ lockedAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(makoLeaderboardIndexerState.chainId, chainId),
        eq(makoLeaderboardIndexerState.contractAddress, contractAddressLower),
        eq(makoLeaderboardIndexerState.lockedAt, acquiredLockedAt),
      ),
    );
}

async function advanceCursorOrThrow(
  chunkTx: DbOrTx,
  chainId: number,
  contractAddressLower: string,
  acquiredLockedAt: Date,
  endOfChunk: number,
): Promise<void> {
  // Ownership-gated advance inside the chunk transaction: if the lock
  // was stale-recovered out from under us this matches 0 rows and the
  // whole chunk (event inserts + advance) rolls back together.
  const advanced = await chunkTx
    .update(makoLeaderboardIndexerState)
    .set({ lastScannedBlock: endOfChunk, updatedAt: new Date() })
    .where(
      and(
        eq(makoLeaderboardIndexerState.chainId, chainId),
        eq(makoLeaderboardIndexerState.contractAddress, contractAddressLower),
        eq(makoLeaderboardIndexerState.lockedAt, acquiredLockedAt),
      ),
    )
    .returning({ chainId: makoLeaderboardIndexerState.chainId });
  if (advanced.length === 0) {
    throw new LeaderboardStaleLockLostError(contractAddressLower);
  }
}

// ---- Log fetch + decode ----------------------------------------------------

type LedgerLog = Awaited<
  ReturnType<typeof fetchLedgerLogs>
>[number];

async function fetchLedgerLogs(
  publicClient: PublicClient,
  address: `0x${string}`,
  fromBlock: number,
  toBlock: number,
) {
  // `events` (plural) filters topic0 to exactly our three signatures
  // AND decodes args — address-scoped per plan NIT-4 (other deployments
  // share these common event signatures; topic-only would ingest
  // foreign rows).
  return publicClient.getLogs({
    address,
    events: LEDGER_EVENTS,
    fromBlock: numberToBigInt(fromBlock),
    toBlock: numberToBigInt(toBlock),
  });
}

/// getLogs with adaptive halving: on any RPC failure, split the span and
/// retry the halves sequentially, flooring at CHUNK_FLOOR. Handles both
/// the public RPC's 100-block range cap and response-size caps without
/// failing the tick. Non-size errors (RPC down) burn a few extra calls
/// before the floor rethrows — acceptable.
async function fetchLogsAdaptive(
  publicClient: PublicClient,
  address: `0x${string}`,
  fromBlock: number,
  toBlock: number,
): Promise<LedgerLog[]> {
  try {
    return await fetchLedgerLogs(publicClient, address, fromBlock, toBlock);
  } catch (err) {
    const span = toBlock - fromBlock + 1;
    if (span <= CHUNK_FLOOR) throw err;
    const mid = fromBlock + Math.floor(span / 2) - 1;
    const left = await fetchLogsAdaptive(publicClient, address, fromBlock, mid);
    const right = await fetchLogsAdaptive(
      publicClient,
      address,
      mid + 1,
      toBlock,
    );
    return [...left, ...right];
  }
}

function decodeToRows(
  logs: LedgerLog[],
  chainId: number,
  contractAddressLower: `0x${string}`,
  version: string,
  blockTimestamps: Map<string, Date>,
): NewMakoMarketEvent[] {
  const rows: NewMakoMarketEvent[] = [];
  for (const log of logs) {
    if (log.blockNumber === null || log.logIndex === null || log.transactionHash === null) {
      // Pending logs can carry nulls; a confirmed-range scan never
      // should. Fail loud rather than insert a broken PK.
      throw new Error(
        `leaderboard indexer: log with null block/tx/index fields in confirmed range (${String(log.transactionHash)})`,
      );
    }
    const blockTimestamp = blockTimestamps.get(log.blockHash as string);
    if (!blockTimestamp) {
      throw new Error(
        `leaderboard indexer: missing block timestamp for ${log.blockHash}`,
      );
    }
    const base = {
      chainId,
      contractAddress: contractAddressLower,
      version,
      blockNumber: bigintToNumber(log.blockNumber),
      blockTimestamp,
      txHash: normalizeHex(log.transactionHash, 32),
      logIndex: log.logIndex,
    };
    switch (log.eventName) {
      case 'BetPlaced':
        rows.push({
          ...base,
          marketId: log.args.id!.toString(),
          kind: 'bet',
          actor: normalizeAddressLower(log.args.user!),
          isYes: log.args.isYes!,
          amount: log.args.amount!.toString(),
        });
        break;
      case 'Claimed':
        rows.push({
          ...base,
          marketId: log.args.id!.toString(),
          kind: 'claim',
          actor: normalizeAddressLower(log.args.user!),
          isYes: null,
          amount: log.args.amount!.toString(),
        });
        break;
      case 'CreatorFeePaid':
        rows.push({
          ...base,
          marketId: log.args.id!.toString(),
          kind: 'creator_fee',
          actor: normalizeAddressLower(log.args.creator!),
          isYes: null,
          amount: log.args.amount!.toString(),
        });
        break;
      default: {
        // events-filtered getLogs should never return anything else.
        const name: string = (log as { eventName: string }).eventName;
        throw new Error(`leaderboard indexer: unexpected event ${name}`);
      }
    }
  }
  return rows;
}

async function prefetchBlockTimestamps(
  publicClient: PublicClient,
  logs: LedgerLog[],
): Promise<Map<string, Date>> {
  const hashes = [...new Set(logs.map((l) => l.blockHash as string))];
  const out = new Map<string, Date>();
  await Promise.all(
    hashes.map(async (hash) => {
      const block = await publicClient.getBlock({
        blockHash: hash as `0x${string}`,
      });
      out.set(hash, new Date(Number(block.timestamp) * 1000));
    }),
  );
  return out;
}

// ---- Orchestrator ----------------------------------------------------------

export async function runLeaderboardIndexerOnce(
  args: RunLeaderboardIndexerArgs,
): Promise<RunLeaderboardIndexerResult> {
  const chainId = args.chainId ?? MONAD_TESTNET_ID;
  const contracts = args.contracts ?? LEADERBOARD_CONTRACTS;
  const chunkSize = args.chunkSize ?? defaultChunkSize();
  const confirmations = args.confirmations ?? LEADERBOARD_CONFIRMATIONS;
  const staleLockMs = args.staleLockMs ?? LEADERBOARD_STALE_LOCK_MS;
  const { db, publicClient, timeBudgetMs } = args;

  for (const [name, val] of [
    ['chunkSize', chunkSize],
    ['confirmations', confirmations],
    ['staleLockMs', staleLockMs],
  ] as const) {
    if (!Number.isInteger(val) || val <= 0) {
      throw new RangeError(
        `runLeaderboardIndexerOnce: ${name} must be a positive integer; got ${val}`,
      );
    }
  }

  const deadline =
    timeBudgetMs === undefined ? Infinity : Date.now() + timeBudgetMs;

  const results: LeaderboardContractScanResult[] = [];

  for (const contract of contracts) {
    const contractAddressLower = normalizeAddressLower(contract.address);

    const acquired = await acquireContractMutex(
      db,
      chainId,
      contractAddressLower,
      staleLockMs,
    );
    if (acquired === null) {
      results.push({
        contractAddress: contractAddressLower,
        mutex: 'busy',
        fromBlock: null,
        scannedTo: null,
        scanTarget: null,
        eventsInserted: 0,
        upToDate: false,
        budgetExhausted: false,
      });
      continue;
    }

    const { lastScannedBlock, acquiredLockedAt, mutexOutcome } = acquired;
    let eventsInserted = 0;
    let budgetExhausted = false;
    let releaseWarning: string | undefined;
    let scannedTo: number | null = null;
    let fromBlock: number | null = null;
    let scanTarget: number | null = null;

    try {
      const head = bigintToNumber(await publicClient.getBlockNumber());
      scanTarget = head - confirmations;
      // Resume at cursor + 1 — no overlap re-scan; see divergence (1).
      fromBlock = Math.max(contract.deployBlock, lastScannedBlock + 1);

      let cursor = fromBlock;
      while (cursor <= scanTarget) {
        if (Date.now() > deadline) {
          budgetExhausted = true;
          break;
        }
        const chunkEnd = Math.min(cursor + chunkSize - 1, scanTarget);

        const logs = await fetchLogsAdaptive(
          publicClient,
          contractAddressLower,
          cursor,
          chunkEnd,
        );
        const timestamps = await prefetchBlockTimestamps(publicClient, logs);
        const rows = decodeToRows(
          logs,
          chainId,
          contractAddressLower,
          contract.version,
          timestamps,
        );

        // Per-chunk transaction: inserts + cursor advance are atomic.
        // onConflictDoNothing makes seed/cron overlap and crash-replay
        // idempotent against the (tx_hash, log_index) PK.
        await (db as DbOrTx & {
          transaction: <T>(fn: (tx: DbOrTx) => Promise<T>) => Promise<T>;
        }).transaction(async (chunkTx) => {
          if (rows.length > 0) {
            await chunkTx
              .insert(makoMarketEvents)
              .values(rows)
              .onConflictDoNothing({
                target: [makoMarketEvents.txHash, makoMarketEvents.logIndex],
              });
          }
          await advanceCursorOrThrow(
            chunkTx,
            chainId,
            contractAddressLower,
            acquiredLockedAt,
            chunkEnd,
          );
        });

        eventsInserted += rows.length;
        scannedTo = chunkEnd;
        cursor = chunkEnd + 1;
        args.onChunk?.({
          contractAddress: contractAddressLower,
          chunkEnd,
          scanTarget,
          rowsInChunk: rows.length,
        });
      }

      results.push({
        contractAddress: contractAddressLower,
        mutex: mutexOutcome,
        fromBlock,
        scannedTo: scannedTo ?? lastScannedBlock,
        scanTarget,
        eventsInserted,
        upToDate: (scannedTo ?? lastScannedBlock) >= scanTarget,
        budgetExhausted,
        releaseWarning,
      });
    } finally {
      try {
        await releaseContractMutex(
          db,
          chainId,
          contractAddressLower,
          acquiredLockedAt,
        );
      } catch (err) {
        releaseWarning = `lock release failed for ${contractAddressLower}: ${
          err instanceof Error ? err.message : String(err)
        } (self-heals via stale recovery after ${staleLockMs}ms)`;
        const last = results[results.length - 1];
        if (last && last.contractAddress === contractAddressLower) {
          last.releaseWarning = releaseWarning;
        }
        console.warn(`[leaderboard-indexer] ${releaseWarning}`);
      }
    }
  }

  return { chainId, contracts: results };
}
