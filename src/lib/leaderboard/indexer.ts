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
//      #214: the re-sync must NOT truncate notify_cursor (migration 0020):
//      that row is what keeps a re-seed from announcing old results again.
//   2. Adaptive halve-on-error chunking. Monad's PUBLIC RPC caps
//      eth_getLogs at a 100-block range (-32614 — documented in
//      admin/analytics/route.ts); private RPCs allow 1k+. Rather than
//      fail the tick on a mis-sized chunk, fetchLogsAdaptive halves the
//      span (floor CHUNK_FLOOR) and retries. The PM scanner lacks this.
//      #214: rate limits, timeouts, 5xx answers and lost connections are
//      retried on the SAME span (1 s, then 2 s) and never halved.
//   3. Multi-contract: one cursor row per (chain_id, contract_address),
//      scanned sequentially. No contract-mismatch guard needed — the PM
//      table keys by chain only; this one keys by (chain, contract).
//
// #214 Notifications S1 (NOTIFICATIONS_PLAN r8 §3.2 "Scanning"): scanContract
// serves this V4 scan and the Rounds scan (notifications/rounds-scan.ts).
//   - Batches of 20 chunks are fetched in parallel through the RPC gate
//     (rpc-gate.ts); batches run one after another. A batch with no logs
//     writes nothing; a batch with logs commits ONE transaction (its rows,
//     its notifications, the notify_cursor statements, the cursor advance).
//   - Cursor rule "empty or committed": the cursor moves only to safeEnd, the
//     end of the unbroken run of batches that were each empty or committed. A
//     batch that fetched logs but whose re-read, position read or transaction
//     failed ends the scan and is fetched again next tick. No block is skipped.
//   - Floor: before the lock the scan reads F (notify_cursor.notified_through,
//     else NOTIFY_FROM_BLOCK − 1). It starts at max(floor, min(cursor, F) + 1),
//     so blocks an old build scanned without notifying are fetched again
//     (ledger rows land as no-ops). The release and the 60 s write move
//     notified_through with the cursor in one ownership-gated statement.
//   - Every V4 scan notifies: the notify route, /api/cron/leaderboard and the
//     seed script. No caller can move notified_through past a resolution in
//     silence.
//
// Cold start: the live v4 deploy block is ~weeks behind head on a
// sub-second chain — millions of blocks. No serverless tick can finish
// that, so the one-time scripts/seed-leaderboard.mts (local Node, no
// function timeout) backfills BEFORE the cron is deployed.
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
import { rowsOf } from '@/db/rows';
import { MONAD_TESTNET_ID } from '@/lib/chain';
import {
  announceBatch,
  marketConfirms,
  notifyFromBlockEnv,
  poolItem,
  readMarketsAtFinalized,
  readNotifyFloor,
  RosterAttemptsExhausted,
  RosterHardStop,
  type AccountSource,
} from '@/lib/notifications/produce';
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
import { classifyRpcError, withRpcRetry } from './rpc-gate';

export { createScanClient, createRpcGate, GateClosed, classifyRpcError, withRpcRetry } from './rpc-gate';

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

/// Soft time budget for the cron path: stop starting new batches this
/// many ms after entry so the tick releases its lock cleanly instead of
/// being killed at maxDuration and holding the lock until stale
/// recovery. The seed script omits the budget entirely (local Node has
/// no function timeout).
export const LEADERBOARD_CRON_TIME_BUDGET_MS =
  (LEADERBOARD_CRON_MAX_DURATION_S - 10) * 1000;

/// #214: no RPC request starts after this many ms from a route's start (the gate's refuseAfter, plan §3.9).
export const ROUTE_HARD_STOP_MS = 48_000;

/// #214: chunks per batch. 20 × 100 blocks = 2,000 blocks on the public RPC.
export const BATCH_CHUNKS = 20;

/// #214: a scan with no deadline (the seed) writes its cursor at least this often, so a crash loses at most a minute
/// of empty batches.
export const CURSOR_WRITE_INTERVAL_MS = 60_000;

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

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
/// #214: the terminal event pool notifications come from. OR-ed into the same getLogs, so no extra calls.
const EVENT_MARKET_RESOLVED = parseAbiItem('event MarketResolved(uint256 indexed id, uint8 outcome)');

const V4_EVENTS = [
  EVENT_BET_PLACED,
  EVENT_CLAIMED,
  EVENT_CREATOR_FEE_PAID,
  EVENT_MARKET_RESOLVED,
] as const;

// ---- Args / results --------------------------------------------------------

export interface RunLeaderboardIndexerArgs {
  /// Top-level Drizzle handle; per-batch transactions open on this.
  db: DbOrTx;
  publicClient: PublicClient;
  /// Defaults to LEADERBOARD_CONTRACTS. Injectable for tests.
  contracts?: readonly LeaderboardContract[];
  chainId?: number;
  chunkSize?: number;
  confirmations?: number;
  staleLockMs?: number;
  /// Stop starting new batches once this many ms have elapsed. Omit for
  /// no budget (seed script). The cron route passes
  /// LEADERBOARD_CRON_TIME_BUDGET_MS; the notify route 16 s.
  timeBudgetMs?: number;
  /// #214: NOTIFY_FROM_BLOCK; defaults to the env var. null = unset.
  notifyFromBlock?: number | null;
  /// #214: no roster attempt starts at or after this absolute ms time (the route's hard stop).
  hardStopAt?: number;
  /// #214 test seams: the retry wait and the account-address reads.
  sleep?: (ms: number) => Promise<void>;
  accounts?: AccountSource;
  now?: () => number;
  /// #214 test seam: runs inside an announcing batch's transaction after its version check, before COMMIT.
  afterVersionCheck?: () => Promise<void>;
  /// Called after each cursor write — the seed script's multi-hour
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
  /// 'error' = this contract's scan failed mid-run; committed batches
  /// persist, the lock was released, and the REMAINING contracts still
  /// ran (review MINOR-5). #214 'no-floor' = a scan that needs a floor
  /// (Rounds) found none: it took no lock and scanned nothing.
  mutex: 'acquired' | 'stale-recovered' | 'busy' | 'error' | 'no-floor';
  /// First block this run scanned (null when busy).
  fromBlock: number | null;
  /// Without a floor: the cursor after this run. With one (#214):
  /// min(last_scanned_block, notified_through), so no scan reports
  /// up to date while a block above its floor is unannounced.
  scannedTo: number | null;
  /// head − confirmations at run entry; the scan target.
  scanTarget: number | null;
  /// Rows that actually landed (onConflictDoNothing survivors via
  /// RETURNING — a re-scan of already-ingested ranges reports 0, not
  /// the decoded count; review NIT-6).
  eventsInserted: number;
  /// True when scannedTo reached scanTarget this run.
  upToDate: boolean;
  /// True when the time budget expired before reaching scanTarget.
  budgetExhausted: boolean;
  /// #214: notify_cursor.notified_through after the run; null when no row exists.
  notifiedThrough: number | null;
  /// #214: no NOTIFY_FROM_BLOCK and no notify_cursor row: nothing is announced.
  noFloor: boolean;
  /// #214: terminal events whose roster came from the contract this run.
  rosterFromChain: number;
  /// Non-empty when the success-path lock release failed (lock then
  /// self-heals via stale recovery). Mirrors the PM pattern.
  releaseWarning?: string;
  /// Present iff mutex === 'error'. 'roster_changed' when every roster attempt saw the account registry change.
  error?: string;
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

/// #214: what a failed scan reports and logs. A fixed code, never the error's message: viem's messages carry the RPC
/// URL (an API key may sit in its path) and the request body (the roster rule's multicall holds every Mako account
/// address), and plan §4 keeps both out of responses and logs.
export function scanErrorCode(err: unknown): string {
  if (err instanceof RosterAttemptsExhausted) return 'roster_changed';
  if (err instanceof RosterHardStop) return 'hard_stop';
  if (err instanceof LeaderboardStaleLockLostError) return 'lock_lost';
  const cls = classifyRpcError(err);
  if (cls === 'gate') return 'gate_closed';
  if (cls === 'retry') return 'rpc_unavailable';
  const name = err instanceof Error && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : 'unknown';
  return `scan_failed:${name}`;
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
  const rows = rowsOf<Record<string, unknown>>(result);
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
  batchTx: DbOrTx,
  chainId: number,
  contractAddressLower: string,
  acquiredLockedAt: Date,
  endOfBatch: number,
  scanTarget: number,
): Promise<void> {
  // Ownership-gated advance inside the batch transaction: if the lock
  // was stale-recovered out from under us this matches 0 rows and the
  // whole batch (rows + advance) rolls back together. last_scan_target
  // rides in the same UPDATE so the read API can derive `syncing`
  // (scanned < target) without an RPC (MAJOR-1). #214: GREATEST, because
  // a scan may now start below the cursor (it re-fetches what an old
  // build scanned without notifying).
  const advanced = await batchTx
    .update(makoLeaderboardIndexerState)
    .set({
      lastScannedBlock: sql`GREATEST(${makoLeaderboardIndexerState.lastScannedBlock}, ${endOfBatch})`,
      lastScanTarget: scanTarget,
      updatedAt: new Date(),
    })
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

/// #214 The cursor write of a release (locked_at cleared) or of the 60 s write (lock kept): the scan cursor to
/// GREATEST(cursor, safeEnd) and, for a scan with a floor, notified_through to GREATEST(F, safeEnd), in ONE statement
/// gated on the lock token. Returns the notify_cursor value written (null without a floor). A lost lock writes
/// neither and throws.
async function writeCursorPair(
  db: DbOrTx,
  p: { chainId: number; contract: string; token: Date; safeEnd: number; target: number; floor: number | null; release: boolean },
): Promise<number | null> {
  const lockClear = p.release ? sql`, locked_at = NULL` : sql``;
  const update = sql`
    UPDATE mako_leaderboard_indexer_state
       SET last_scanned_block = GREATEST(last_scanned_block, ${p.safeEnd}),
           last_scan_target   = ${p.target}${lockClear},
           updated_at         = now()
     WHERE chain_id = ${p.chainId} AND contract_address = ${p.contract}
       AND locked_at = ${p.token.toISOString()}::timestamptz
    RETURNING 1 AS ok`;
  if (p.floor === null) {
    if (rowsOf(await db.execute(update)).length === 0) throw new LeaderboardStaleLockLostError(p.contract);
    return null;
  }
  const rows = rowsOf<{ nt: number | string }>(
    await db.execute(sql`
      WITH s AS (${update})
      INSERT INTO notify_cursor (chain_id, contract_address, notified_through)
      SELECT ${p.chainId}, ${p.contract}, GREATEST(${p.floor}::bigint, ${p.safeEnd}::bigint) FROM s
      ON CONFLICT (chain_id, contract_address)
      DO UPDATE SET notified_through = GREATEST(notify_cursor.notified_through, EXCLUDED.notified_through)
      RETURNING notified_through AS nt`),
  );
  if (rows.length === 0) throw new LeaderboardStaleLockLostError(p.contract);
  return Number(rows[0].nt);
}

// ---- Generic scan (#214) ---------------------------------------------------

/// The log fields the scanner itself reads; each contract's writer narrows further.
export interface ScanLog {
  blockNumber: bigint | null;
  logIndex: number | null;
  blockHash: `0x${string}` | null;
  transactionHash: `0x${string}` | null;
  eventName: string;
}

export interface BatchContext<L extends ScanLog> {
  db: DbOrTx;
  publicClient: PublicClient;
  chainId: number;
  contractLower: `0x${string}`;
  /// The batch's logs, in block then log order.
  logs: L[];
  batchEnd: number;
  /// null: no floor, announce nothing. Else seed = NOTIFY_FROM_BLOCK − 1 (null when the env var is unset).
  notify: { seed: number | null } | null;
  /// The ownership-gated cursor advance to batchEnd; call it inside the batch transaction.
  advanceCursor(tx: DbOrTx): Promise<void>;
  sleep: (ms: number) => Promise<void>;
  hardStopAt?: number;
  accounts?: AccountSource;
  now?: () => number;
  afterVersionCheck?: () => Promise<void>;
}

export interface BatchWriteResult {
  eventsInserted: number;
  rosterFromChain: number;
  /// notify_cursor after the batch, when the batch announced; else null.
  notifiedThrough: number | null;
}

export interface ScanContractArgs<L extends ScanLog> {
  db: DbOrTx;
  publicClient: PublicClient;
  chainId: number;
  contractLower: `0x${string}`;
  /// The scan's lowest block for a notify floor F (null = none). V4: its deploy block. Rounds: F + 1 − 60,000, or
  /// null without F, which means "report noFloor, take no lock, scan nothing".
  floorFor(F: number | null): number | null;
  notifyFromBlock: number | null;
  fetchLogs(fromBlock: number, toBlock: number): Promise<L[]>;
  writeBatch(ctx: BatchContext<L>): Promise<BatchWriteResult>;
  chunkSize: number;
  confirmations: number;
  staleLockMs: number;
  /// Absolute ms time after which no batch starts (Infinity for none).
  deadline: number;
  hardStopAt?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  accounts?: AccountSource;
  afterVersionCheck?: () => Promise<void>;
  onChunk?: RunLeaderboardIndexerArgs['onChunk'];
}

/// getLogs with retries and adaptive halving: a rate limit, timeout, 5xx or lost connection is retried on the SAME
/// span (withRpcRetry) and never halved; GateClosed fails at once; anything else (the range cap) splits the span and
/// retries the halves sequentially, flooring at CHUNK_FLOOR.
async function fetchLogsAdaptive<L>(
  fetch: (from: number, to: number) => Promise<L[]>,
  fromBlock: number,
  toBlock: number,
  sleep: (ms: number) => Promise<void>,
): Promise<L[]> {
  try {
    return await withRpcRetry(() => fetch(fromBlock, toBlock), sleep);
  } catch (err) {
    if (classifyRpcError(err) !== 'other') throw err;
    const span = toBlock - fromBlock + 1;
    if (span <= CHUNK_FLOOR) throw err;
    const mid = fromBlock + Math.floor(span / 2) - 1;
    const left = await fetchLogsAdaptive(fetch, fromBlock, mid, sleep);
    const right = await fetchLogsAdaptive(fetch, mid + 1, toBlock, sleep);
    return [...left, ...right];
  }
}

export async function scanContract<L extends ScanLog>(a: ScanContractArgs<L>): Promise<LeaderboardContractScanResult> {
  const now = a.now ?? Date.now;
  const sleep = a.sleep ?? realSleep;
  const c = a.contractLower;
  const { floor: F, fromRow } = await readNotifyFloor(a.db, a.chainId, c, a.notifyFromBlock);
  const scanFloor = a.floorFor(F);
  if (scanFloor === null) {
    return {
      contractAddress: c, mutex: 'no-floor', fromBlock: null, scannedTo: null, scanTarget: null, eventsInserted: 0,
      upToDate: false, budgetExhausted: false, notifiedThrough: null, noFloor: true, rosterFromChain: 0,
    };
  }
  const notify = F === null ? null : { seed: a.notifyFromBlock === null ? null : a.notifyFromBlock - 1 };

  let token: Date | null = null;
  let last = 0;
  let mutexOutcome: 'acquired' | 'stale-recovered' = 'acquired';
  let fromBlock: number | null = null;
  let scanTarget: number | null = null;
  let safeEnd: number | null = null;
  let notifiedThrough: number | null = fromRow ? F : null;
  let eventsInserted = 0;
  let rosterFromChain = 0;
  let budgetExhausted = false;
  let error: string | undefined;
  let releaseWarning: string | undefined;
  const noteNt = (v: number | null) => {
    if (v !== null) notifiedThrough = Math.max(notifiedThrough ?? v, v);
  };

  try {
    const acquired = await acquireContractMutex(a.db, a.chainId, c, a.staleLockMs);
    if (acquired === null) {
      return {
        contractAddress: c, mutex: 'busy', fromBlock: null, scannedTo: null, scanTarget: null, eventsInserted: 0,
        upToDate: false, budgetExhausted: false, notifiedThrough, noFloor: F === null, rosterFromChain: 0,
      };
    }
    token = acquired.acquiredLockedAt;
    last = acquired.lastScannedBlock;
    mutexOutcome = acquired.mutexOutcome;

    const head = bigintToNumber(await withRpcRetry(() => a.publicClient.getBlockNumber(), sleep));
    const target = head - a.confirmations;
    scanTarget = target;
    // Resume at cursor + 1 — no overlap re-scan; see divergence (1). #214: never above notified_through + 1.
    fromBlock = F !== null ? Math.max(scanFloor, Math.min(last, F) + 1) : Math.max(scanFloor, last + 1);

    const lockToken = token;
    let cursor = fromBlock;
    let lastWriteAt = now();
    let lastWritten = -Infinity;
    while (cursor <= target) {
      if (now() > a.deadline) {
        budgetExhausted = true;
        break;
      }
      const batchEnd = Math.min(cursor + BATCH_CHUNKS * a.chunkSize - 1, target);
      const spans: [number, number][] = [];
      for (let s = cursor; s <= batchEnd; s += a.chunkSize) spans.push([s, Math.min(s + a.chunkSize - 1, batchEnd)]);
      const logs = (await Promise.all(spans.map(([f, t]) => fetchLogsAdaptive((x, y) => a.fetchLogs(x, y), f, t, sleep)))).flat();
      if (logs.length > 0) {
        const r = await a.writeBatch({
          db: a.db,
          publicClient: a.publicClient,
          chainId: a.chainId,
          contractLower: c,
          logs,
          batchEnd,
          notify,
          advanceCursor: (tx) => advanceCursorOrThrow(tx, a.chainId, c, lockToken, batchEnd, target),
          sleep,
          hardStopAt: a.hardStopAt,
          accounts: a.accounts,
          now: a.now,
          afterVersionCheck: a.afterVersionCheck,
        });
        eventsInserted += r.eventsInserted;
        rosterFromChain += r.rosterFromChain;
        noteNt(r.notifiedThrough);
        lastWriteAt = now();
        lastWritten = batchEnd;
        a.onChunk?.({ contractAddress: c, chunkEnd: batchEnd, scanTarget: target, rowsInChunk: r.eventsInserted });
      }
      safeEnd = batchEnd;
      cursor = batchEnd + 1;
      if (now() - lastWriteAt >= CURSOR_WRITE_INTERVAL_MS && safeEnd > lastWritten) {
        noteNt(await writeCursorPair(a.db, { chainId: a.chainId, contract: c, token: lockToken, safeEnd, target, floor: F, release: false }));
        lastWriteAt = now();
        lastWritten = safeEnd;
        a.onChunk?.({ contractAddress: c, chunkEnd: safeEnd, scanTarget: target, rowsInChunk: 0 });
      }
    }
  } catch (err) {
    error = scanErrorCode(err);
    console.warn(`[leaderboard-indexer] ${c} scan failed: ${error}; continuing with remaining contracts`);
  } finally {
    if (token !== null) {
      try {
        // "If no batch of this run was empty or committed, clear locked_at only."
        if (safeEnd !== null && scanTarget !== null) {
          noteNt(await writeCursorPair(a.db, { chainId: a.chainId, contract: c, token, safeEnd, target: scanTarget, floor: F, release: true }));
        } else {
          await releaseContractMutex(a.db, a.chainId, c, token);
        }
      } catch (err) {
        releaseWarning = `lock release failed for ${c}: ${
          err instanceof Error ? err.message : String(err)
        } (self-heals via stale recovery after ${a.staleLockMs}ms)`;
        console.warn(`[leaderboard-indexer] ${releaseWarning}`);
      }
    }
  }

  const cursorAfter = safeEnd !== null ? Math.max(last, safeEnd) : last;
  const effectiveNt = notifiedThrough ?? F;
  const scannedTo = effectiveNt !== null ? Math.min(cursorAfter, effectiveNt) : cursorAfter;
  return {
    contractAddress: c,
    mutex: error !== undefined ? 'error' : mutexOutcome,
    fromBlock,
    scannedTo,
    scanTarget,
    eventsInserted, // committed batches persisted even after a failure
    upToDate: error === undefined && scanTarget !== null && scannedTo >= scanTarget,
    budgetExhausted,
    notifiedThrough,
    noFloor: F === null,
    rosterFromChain,
    ...(releaseWarning ? { releaseWarning } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

// ---- V4 log decode ---------------------------------------------------------

interface V4Log extends ScanLog {
  args: Record<string, unknown>;
}

function decodeToRows(
  logs: V4Log[],
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
    const args = log.args as { id: bigint; user?: `0x${string}`; creator?: `0x${string}`; isYes?: boolean; amount: bigint };
    switch (log.eventName) {
      case 'BetPlaced':
        rows.push({
          ...base,
          marketId: args.id.toString(),
          kind: 'bet',
          actor: normalizeAddressLower(args.user!),
          isYes: args.isYes!,
          amount: args.amount.toString(),
        });
        break;
      case 'Claimed':
        rows.push({
          ...base,
          marketId: args.id.toString(),
          kind: 'claim',
          actor: normalizeAddressLower(args.user!),
          isYes: null,
          amount: args.amount.toString(),
        });
        break;
      case 'CreatorFeePaid':
        rows.push({
          ...base,
          marketId: args.id.toString(),
          kind: 'creator_fee',
          actor: normalizeAddressLower(args.creator!),
          isYes: null,
          amount: args.amount.toString(),
        });
        break;
      default: {
        // events-filtered getLogs should never return anything else
        // (MarketResolved is split off before this is called).
        throw new Error(`leaderboard indexer: unexpected event ${log.eventName}`);
      }
    }
  }
  return rows;
}

/// Concurrency cap for getBlock prefetches. Steady-state batches carry
/// a handful of event blocks; the SEED path (LEADERBOARD_LOG_CHUNK
/// 1000+, no time budget) can carry hundreds — unbounded Promise.all
/// there hammers the RPC exactly on the long-pole path (review
/// MINOR-4; mirrors the PM indexer's prefetchBatchSize discipline).
const TIMESTAMP_PREFETCH_BATCH = 15;

export async function prefetchBlockTimestamps(
  publicClient: PublicClient,
  logs: readonly ScanLog[],
  sleep: (ms: number) => Promise<void> = realSleep,
): Promise<Map<string, Date>> {
  const hashes = [...new Set(logs.map((l) => l.blockHash as string))];
  const out = new Map<string, Date>();
  for (let i = 0; i < hashes.length; i += TIMESTAMP_PREFETCH_BATCH) {
    const batch = hashes.slice(i, i + TIMESTAMP_PREFETCH_BATCH);
    await Promise.all(
      batch.map(async (hash) => {
        const block = await withRpcRetry(() => publicClient.getBlock({ blockHash: hash as `0x${string}` }), sleep);
        out.set(hash, new Date(Number(block.timestamp) * 1000));
      }),
    );
  }
  return out;
}

type Tx = DbOrTx & { transaction: <T>(fn: (tx: DbOrTx) => Promise<T>) => Promise<T> };

/// The V4 batch writer: ledger rows always; pool notifications for each MarketResolved above notified_through, after
/// a 'finalized' re-read confirms it (resolved, same outcome) — else the batch fails and is fetched again next tick.
function v4BatchWriter(contract: LeaderboardContract) {
  return async (ctx: BatchContext<V4Log>): Promise<BatchWriteResult> => {
    const { db, chainId, contractLower } = ctx;
    const timestamps = await prefetchBlockTimestamps(ctx.publicClient, ctx.logs, ctx.sleep);
    const rows = decodeToRows(
      ctx.logs.filter((l) => l.eventName !== 'MarketResolved'),
      chainId,
      contractLower,
      contract.version,
      timestamps,
    );
    // onConflictDoNothing makes seed/cron overlap and crash-replay idempotent against the (tx_hash, log_index) PK;
    // RETURNING gives the count of rows that actually landed (NIT-6 — re-scans report 0, not the decoded count).
    const writeRows = async (tx: DbOrTx) =>
      rows.length === 0
        ? 0
        : (
            await tx
              .insert(makoMarketEvents)
              .values(rows)
              .onConflictDoNothing({ target: [makoMarketEvents.txHash, makoMarketEvents.logIndex] })
              .returning({ txHash: makoMarketEvents.txHash })
          ).length;

    let candidates: V4Log[] = [];
    if (ctx.notify !== null) {
      const nt0 = (await readNotifyFloor(db, chainId, contractLower, null)).floor ?? ctx.notify.seed;
      if (nt0 !== null) {
        candidates = ctx.logs.filter((l) => l.eventName === 'MarketResolved' && bigintToNumber(l.blockNumber!) > nt0);
      }
    }
    if (candidates.length === 0) {
      let inserted = 0;
      await (db as Tx).transaction(async (tx) => {
        inserted = await writeRows(tx);
        await ctx.advanceCursor(tx);
      });
      return { eventsInserted: inserted, rosterFromChain: 0, notifiedThrough: null };
    }

    const ids = [...new Set(candidates.map((l) => l.args.id as bigint))];
    const markets = await readMarketsAtFinalized(ctx.publicClient, contractLower, ids, ctx.sleep);
    const byId = new Map(ids.map((id, i) => [id, markets[i]]));
    const items = candidates.map((l) => {
      const id = l.args.id as bigint;
      const outcome = Number(l.args.outcome);
      const market = byId.get(id)!;
      if (!marketConfirms(market, outcome)) {
        throw new Error(`pool ${id.toString()}: the finalized re-read does not confirm MarketResolved(${outcome})`);
      }
      return poolItem(
        db,
        ctx.publicClient,
        {
          contractLower,
          chainId,
          id,
          outcome,
          blockNumber: bigintToNumber(l.blockNumber!),
          eventAt: timestamps.get(l.blockHash as string)!,
          market,
          batchBets: rows
            .filter((r) => r.kind === 'bet' && r.marketId === id.toString())
            .map((r) => ({ actor: r.actor, isYes: r.isYes === true })),
        },
        ctx.sleep,
      );
    });
    const r = await announceBatch({
      db,
      chainId,
      contractLower,
      batchEnd: ctx.batchEnd,
      seedNotifiedThrough: ctx.notify!.seed,
      items,
      writeRows,
      advanceCursor: ctx.advanceCursor,
      accounts: ctx.accounts,
      hardStopAt: ctx.hardStopAt,
      now: ctx.now,
      afterVersionCheck: ctx.afterVersionCheck,
    });
    return { eventsInserted: r.inserted, rosterFromChain: r.rosterFromChain, notifiedThrough: r.notifiedThrough };
  };
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
  const notifyFromBlock = args.notifyFromBlock === undefined ? notifyFromBlockEnv() : args.notifyFromBlock;
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

  const now = args.now ?? Date.now;
  const deadline =
    timeBudgetMs === undefined ? Infinity : now() + timeBudgetMs;

  const results: LeaderboardContractScanResult[] = [];
  // Per-contract isolation: a failure for one contract records an 'error'
  // result and the loop moves on (MINOR-5).
  for (const contract of contracts) {
    const contractLower = normalizeAddressLower(contract.address);
    try {
      results.push(
        await scanContract<V4Log>({
          db,
          publicClient,
          chainId,
          contractLower,
          floorFor: () => contract.deployBlock,
          notifyFromBlock,
          // `events` (plural) filters topic0 to exactly our signatures AND
          // decodes args — address-scoped per plan NIT-4 (other deployments
          // share these common event signatures).
          fetchLogs: async (from, to) =>
            (await publicClient.getLogs({
              address: contractLower,
              events: V4_EVENTS,
              fromBlock: numberToBigInt(from),
              toBlock: numberToBigInt(to),
            })) as unknown as V4Log[],
          writeBatch: v4BatchWriter(contract),
          chunkSize,
          confirmations,
          staleLockMs,
          deadline,
          hardStopAt: args.hardStopAt,
          sleep: args.sleep,
          now: args.now,
          accounts: args.accounts,
          afterVersionCheck: args.afterVersionCheck,
          onChunk: args.onChunk,
        }),
      );
    } catch (err) {
      // The floor read itself failed (before any lock): record it and move on.
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[leaderboard-indexer] ${contractLower} scan failed: ${message}; continuing with remaining contracts`);
      results.push({
        contractAddress: contractLower, mutex: 'error', fromBlock: null, scannedTo: null, scanTarget: null,
        eventsInserted: 0, upToDate: false, budgetExhausted: false, notifiedThrough: null, noFloor: notifyFromBlock === null,
        rosterFromChain: 0, error: message,
      });
    }
  }

  return { chainId, contracts: results };
}
