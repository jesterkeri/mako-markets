import 'server-only';

// ----------------------------------------------------------------------------
// src/lib/private-markets/queries.ts
//
// 2B-2 read queries: getMarketBySlug + getMarketByMarketId. Both
// scoped to the active row set (create_status IN ('pending',
// 'confirmed')) — the partial unique index pm_markets_slug_active_uniq
// guarantees at-most-one match per slug there. Failed/abandoned rows
// keep their slug as audit history but are NOT returned by these
// helpers.
//
// Returned shape is DB-native: lowercase enum strings, non-null
// description / streamUrl per the schema's NOT NULL DEFAULT '',
// `marketId: number | null` per the schema's `mode: 'number'`,
// numeric(78, 0) amounts as JS strings, timestamps as Date.
// UI is responsible for any human-facing renaming.
//
// 2F lookup against the full slug history is stubbed at the bottom
// (real symbol that throws — not `export declare` — so accidental
// imports from 2B-2 callers fail loud rather than resolving to
// undefined).
// ----------------------------------------------------------------------------

import {
  and,
  asc,
  desc,
  eq,
  exists,
  inArray,
  or,
  sql,
} from 'drizzle-orm';
import type { PublicClient } from 'viem';

import { db } from '@/db/client';
import {
  pmClaims,
  pmMarkets,
  pmOptions,
  pmStakes,
} from '@/db/schema';
import { privateMarketsAbi } from '@/lib/MakoPrivateMarketsV1.abi';

import { logObservation } from './alerting';
import {
  effectiveState,
  parseNonNegativeDecimal,
  type EffectiveState,
  type EffectiveStateInput,
} from './effective-state';
import { normalizeHex } from './normalize';

// Re-export for callers — single import surface.
export {
  effectiveState,
  parseNonNegativeDecimal,
  POST_CLOSE_GRACE_MS,
} from './effective-state';
export type {
  EffectiveState,
  EffectiveStateInput,
} from './effective-state';

export interface PrivateMarketView {
  id: string;
  chainId: number;
  contractAddress: `0x${string}`;
  slug: string;
  clientNonce: `0x${string}`;
  userOpHash: `0x${string}` | null;
  marketId: number | null;
  creator: `0x${string}`;
  shape: 'friendly' | 'open_vote' | 'prize_pool';
  createStatus: 'pending' | 'confirmed' | 'failed' | 'abandoned';
  pendingAt: Date;
  confirmedAt: Date | null;
  failedAt: Date | null;
  failureReason: string | null;
  title: string;
  description: string;
  streamUrl: string;
  visibilityView: number;
  visibilityParticipation: number;
  stakingOpensAt: Date;
  closeAt: Date;
  perStakeMin: string;
  perStakeMax: string;
  perWalletCumulativeMax: string;
  fixedStake: string;
  winnersCount: number;
  currentState:
    | 'created'
    | 'resolved'
    | 'empty_pool_resolved'
    | 'canceled'
    | 'timed_out'
    | 'zero_stake_expired';
  friendlyOutcome: number | null;
  friendlyEmptyPoolPath: boolean | null;
  feeTaken: string;
  dust: string;
  totalStake: string;
  frozenAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  options: Array<{
    optionIndex: number;
    label: string;
    participantWallet: `0x${string}` | null;
    poolTotal: string;
    firstStakeSequence: number | null;
  }>;
}

/// Drizzle row → PrivateMarketView mapping. The DB returns clean
/// scalar types matching the column declarations; this helper just
/// fans them out plus assembles the options join.
function rowToView(
  market: typeof pmMarkets.$inferSelect,
  options: Array<typeof pmOptions.$inferSelect>,
): PrivateMarketView {
  return {
    id: market.id,
    chainId: market.chainId,
    contractAddress: market.contractAddress as `0x${string}`,
    slug: market.slug,
    clientNonce: market.clientNonce as `0x${string}`,
    userOpHash: market.userOpHash as `0x${string}` | null,
    marketId: market.marketId,
    creator: market.creator as `0x${string}`,
    shape: market.shape,
    createStatus: market.createStatus,
    pendingAt: market.pendingAt,
    confirmedAt: market.confirmedAt,
    failedAt: market.failedAt,
    failureReason: market.failureReason,
    title: market.title,
    description: market.description,
    streamUrl: market.streamUrl,
    visibilityView: market.visibilityView,
    visibilityParticipation: market.visibilityParticipation,
    stakingOpensAt: market.stakingOpensAt,
    closeAt: market.closeAt,
    perStakeMin: market.perStakeMin,
    perStakeMax: market.perStakeMax,
    perWalletCumulativeMax: market.perWalletCumulativeMax,
    fixedStake: market.fixedStake,
    winnersCount: market.winnersCount,
    currentState: market.currentState,
    friendlyOutcome: market.friendlyOutcome,
    friendlyEmptyPoolPath: market.friendlyEmptyPoolPath,
    feeTaken: market.feeTaken,
    dust: market.dust,
    totalStake: market.totalStake,
    frozenAt: market.frozenAt,
    createdAt: market.createdAt,
    updatedAt: market.updatedAt,
    options: options
      .slice()
      .sort((a, b) => a.optionIndex - b.optionIndex)
      .map((o) => ({
        optionIndex: o.optionIndex,
        label: o.label,
        participantWallet: o.participantWallet as `0x${string}` | null,
        poolTotal: o.poolTotal,
        firstStakeSequence: o.firstStakeSequence,
      })),
  };
}

/// Fetch an active market by slug. Active = create_status IN
/// ('pending', 'confirmed') per partial unique index
/// pm_markets_slug_active_uniq. Failed/abandoned rows are excluded
/// (they may share the slug with a newer active row).
export async function getMarketBySlug(
  slug: string,
): Promise<PrivateMarketView | null> {
  const market = await db.query.pmMarkets.findFirst({
    where: and(
      eq(pmMarkets.slug, slug),
      inArray(pmMarkets.createStatus, ['pending', 'confirmed']),
    ),
  });
  if (!market) return null;

  const options = await db
    .select()
    .from(pmOptions)
    .where(eq(pmOptions.marketDbId, market.id))
    .orderBy(asc(pmOptions.optionIndex));

  return rowToView(market, options);
}

/// Fetch a confirmed market by (chainId, contractAddress, marketId).
/// Pending rows have NULL marketId so they don't surface here. The
/// partial unique index pm_markets_chain_market_id_uniq is on
/// `WHERE market_id IS NOT NULL`, so at-most-one match.
///
/// `marketId: number` matches the schema's `mode: 'number'` choice.
/// `contractAddress` is normalized inside; callers can pass either
/// the lowercase or checksummed form.
export async function getMarketByMarketId(
  chainId: number,
  contractAddress: `0x${string}`,
  marketId: number,
): Promise<PrivateMarketView | null> {
  const contractAddressLower = normalizeHex(contractAddress, 20);
  const market = await db.query.pmMarkets.findFirst({
    where: and(
      eq(pmMarkets.chainId, chainId),
      eq(pmMarkets.contractAddress, contractAddressLower),
      eq(pmMarkets.marketId, marketId),
    ),
  });
  if (!market) return null;

  const options = await db
    .select()
    .from(pmOptions)
    .where(eq(pmOptions.marketDbId, market.id))
    .orderBy(asc(pmOptions.optionIndex));

  return rowToView(market, options);
}

/// 2F-only. Returns rows for a slug across all create_status values
/// (history). Out of 2B-2 scope. Real runtime symbol that throws so
/// accidental imports from 2B-2 callers fail loud rather than
/// resolving to undefined (the `export declare` form would).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function getMarketBySlugIncludingHistory(
  slug: string,
): Promise<PrivateMarketView[]> {
  throw new Error('Not implemented in 2B-2 (lands in Phase 2F)');
}

// ============================================================================
// Phase 2B-6 — pending-claim queries + listing helpers
// ============================================================================

// ---- DB call counter (test scaffolding, Codex r5 m3 + r2 n1) ---------------
//
// Tests assign a counter via __setDbCallCounter to assert that
// getPendingClaimsForWallet hydrates via at most 4 SQL round-trips
// regardless of candidate count: 1 candidateMarkets always runs;
// when the candidate set is empty the helper short-circuits and
// options/stakes/claims are skipped (each remains 0). With ≥1
// candidate, all four are incremented exactly once.
// Production overhead = ONE null-check per call.

type DbCallCategory =
  | 'candidateMarkets'
  | 'options'
  | 'stakes'
  | 'claims';
type DbCallCounter = Record<DbCallCategory, number>;
let __dbCallCounter: DbCallCounter | null = null;

function __recordDbCall(c: DbCallCategory): void {
  if (__dbCallCounter !== null) __dbCallCounter[c]++;
}

/// @internal Test-only. Throws outside the test environment so a
/// misbehaving route can't ship a counter into production logs.
export function __setDbCallCounter(counter: DbCallCounter | null): void {
  if (
    process.env.MAKO_STAGE !== 'test' &&
    process.env.NODE_ENV !== 'test'
  ) {
    throw new Error('__setDbCallCounter: test-only');
  }
  __dbCallCounter = counter;
}

// ---- Result types ----------------------------------------------------------

export interface PendingClaimRow {
  market: PrivateMarketView;
  /// Display-only effective state derived from row + `now`. NOT used
  /// for filtering — chain `getPendingClaim` is the inclusion gate.
  effectiveStateAt: EffectiveState;
  /// Authoritative on-chain amount (decimal string). Null if the
  /// multicall reverted for this row (logged + included so UI can
  /// render "—" rather than dropping the entry).
  pendingAmountOnChain: string | null;
  /// Sum of pm_claims for (market, recipient=wallet). Decimal string.
  alreadyClaimedFromAudit: string;
  /// User's stake breakdown per optionIndex. Empty for participant-
  /// only Prize Pool markets where the wallet didn't stake.
  stakes: Array<{ optionIndex: number; amount: string }>;
}

export interface PendingClaimsResult {
  rows: PendingClaimRow[];
  /// True when the candidate set hit candidateCap.
  truncated: boolean;
  candidateCap: number;
  /// Pre-filter candidate count (= number of multicall reads
  /// attempted). Diverges from rows.length when the default filter
  /// excludes successful '0' reads.
  readAttemptCount: number;
  readFailureCount: number;
  chainReadStatus: 'ok' | 'degraded' | 'failed';
}

export interface PaginatedMarketRow {
  market: PrivateMarketView;
  effectiveStateAt: EffectiveState;
}

export interface PaginatedMarketRows {
  rows: PaginatedMarketRow[];
  /// Post-filter count within the capped candidate window. Exact when
  /// truncated=false; lower-bound when truncated=true.
  totalCount: number;
  truncated: boolean;
  candidateCap: number;
}

const DEFAULT_CANDIDATE_CAP = 500;
const DEFAULT_LIMIT = 50;
const DEFAULT_MULTICALL_BATCH = 50;

/// Codex 2B-6 r1 M2 + r2 M1: validate numeric pagination/batch knobs
/// before they reach the SQL/multicall loop. multicallBatchSize must
/// be a positive SAFE integer (zero or negative would loop forever or
/// skip reads; values above 2^53 silently lose precision in BigInt
/// conversions). candidateCap and limit must be positive safe integers;
/// offset must be a non-negative safe integer. Number.isSafeInteger
/// rejects NaN, Infinity, -Infinity, fractional values, and integers
/// outside [-(2^53 - 1), 2^53 - 1].
function assertPositiveInt(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(
      `${name} must be a positive safe integer (got ${value})`,
    );
  }
}
function assertNonNegativeInt(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(
      `${name} must be a non-negative safe integer (got ${value})`,
    );
  }
}

// ---- getStakesForWallet ----------------------------------------------------

export async function getStakesForWallet(args: {
  chainId: number;
  contractAddress: `0x${string}`;
  wallet: `0x${string}`;
}): Promise<
  Array<{
    marketId: number;
    optionIndex: number;
    amount: string;
    txHash: `0x${string}`;
    logIndex: number;
    blockTimestamp: Date;
  }>
> {
  const contractLower = normalizeHex(args.contractAddress, 20);
  const walletLower = normalizeHex(args.wallet, 20);
  const rows = await db
    .select({
      marketId: pmStakes.marketId,
      optionIndex: pmStakes.optionIndex,
      amount: pmStakes.amount,
      txHash: pmStakes.txHash,
      logIndex: pmStakes.logIndex,
      blockTimestamp: pmStakes.blockTimestamp,
    })
    .from(pmStakes)
    .where(
      and(
        eq(pmStakes.chainId, args.chainId),
        eq(pmStakes.contractAddress, contractLower),
        eq(pmStakes.staker, walletLower),
      ),
    )
    .orderBy(
      desc(pmStakes.blockTimestamp),
      desc(pmStakes.blockNumber),
      desc(pmStakes.logIndex),
    );
  return rows.map((r) => ({
    marketId: Number(r.marketId),
    optionIndex: r.optionIndex,
    amount: r.amount,
    txHash: r.txHash as `0x${string}`,
    logIndex: r.logIndex,
    blockTimestamp: r.blockTimestamp,
  }));
}

// ---- getClaimsForWallet ----------------------------------------------------

export async function getClaimsForWallet(args: {
  chainId: number;
  contractAddress: `0x${string}`;
  wallet: `0x${string}`;
}): Promise<
  Array<{
    marketId: number;
    amount: string;
    txHash: `0x${string}`;
    logIndex: number;
    blockTimestamp: Date;
  }>
> {
  const contractLower = normalizeHex(args.contractAddress, 20);
  const walletLower = normalizeHex(args.wallet, 20);
  const rows = await db
    .select({
      marketId: pmClaims.marketId,
      amount: pmClaims.amount,
      txHash: pmClaims.txHash,
      logIndex: pmClaims.logIndex,
      blockTimestamp: pmClaims.blockTimestamp,
    })
    .from(pmClaims)
    .where(
      and(
        eq(pmClaims.chainId, args.chainId),
        eq(pmClaims.contractAddress, contractLower),
        eq(pmClaims.recipient, walletLower),
      ),
    )
    .orderBy(
      desc(pmClaims.blockTimestamp),
      desc(pmClaims.blockNumber),
      desc(pmClaims.logIndex),
    );
  return rows.map((r) => ({
    marketId: Number(r.marketId),
    amount: r.amount,
    txHash: r.txHash as `0x${string}`,
    logIndex: r.logIndex,
    blockTimestamp: r.blockTimestamp,
  }));
}

// ---- getPendingClaimsForWallet --------------------------------------------

export async function getPendingClaimsForWallet(args: {
  chainId: number;
  contractAddress: `0x${string}`;
  wallet: `0x${string}`;
  publicClient: PublicClient;
  now: Date;
  includePending?: boolean;
  includeFullyClaimed?: boolean;
  multicallBatchSize?: number;
  candidateCap?: number;
}): Promise<PendingClaimsResult> {
  const includePending = args.includePending ?? false;
  const includeFullyClaimed = args.includeFullyClaimed ?? false;
  const multicallBatchSize =
    args.multicallBatchSize ?? DEFAULT_MULTICALL_BATCH;
  const candidateCap = args.candidateCap ?? DEFAULT_CANDIDATE_CAP;
  assertPositiveInt('multicallBatchSize', multicallBatchSize);
  assertPositiveInt('candidateCap', candidateCap);
  const contractLower = normalizeHex(args.contractAddress, 20);
  const walletLower = normalizeHex(args.wallet, 20);

  // Step 1: candidate set + pm_markets hydration via single SQL.
  // Codex r4 M2/M3: full pm_markets row, both marketDbId + marketId.
  __recordDbCall('candidateMarkets');
  const stakerExists = sql`EXISTS (
    SELECT 1 FROM ${pmStakes}
     WHERE ${pmStakes.chainId} = ${args.chainId}
       AND ${pmStakes.contractAddress} = ${contractLower}
       AND ${pmStakes.staker} = ${walletLower}
       AND ${pmStakes.marketId} = ${pmMarkets.marketId}
  )`;
  const participantExists = sql`EXISTS (
    SELECT 1 FROM ${pmOptions}
     WHERE ${pmOptions.marketDbId} = ${pmMarkets.id}
       AND ${pmOptions.participantWallet} = ${walletLower}
  )`;
  const rawCandidates = await db
    .select()
    .from(pmMarkets)
    .where(
      and(
        eq(pmMarkets.chainId, args.chainId),
        eq(pmMarkets.contractAddress, contractLower),
        eq(pmMarkets.createStatus, 'confirmed'),
        or(stakerExists, participantExists),
      ),
    )
    .orderBy(desc(pmMarkets.confirmedAt), desc(pmMarkets.marketId))
    .limit(candidateCap + 1);

  const truncated = rawCandidates.length > candidateCap;
  const candidates = rawCandidates.slice(0, candidateCap);

  if (candidates.length === 0) {
    return {
      rows: [],
      truncated,
      candidateCap,
      readAttemptCount: 0,
      readFailureCount: 0,
      chainReadStatus: 'ok',
    };
  }

  const marketDbIds = candidates.map((c) => c.id);
  const marketIds = candidates
    .map((c) => c.marketId)
    .filter((m): m is number => m !== null);

  // Step 2: pm_options batch.
  __recordDbCall('options');
  const optionRows = await db
    .select()
    .from(pmOptions)
    .where(inArray(pmOptions.marketDbId, marketDbIds));
  const optionsByDbId = new Map<string, typeof pmOptions.$inferSelect[]>();
  for (const o of optionRows) {
    const arr = optionsByDbId.get(o.marketDbId) ?? [];
    arr.push(o);
    optionsByDbId.set(o.marketDbId, arr);
  }

  // Step 3: pm_stakes batch (wallet-scoped).
  __recordDbCall('stakes');
  const stakeRows =
    marketIds.length === 0
      ? []
      : await db
          .select()
          .from(pmStakes)
          .where(
            and(
              eq(pmStakes.chainId, args.chainId),
              eq(pmStakes.contractAddress, contractLower),
              eq(pmStakes.staker, walletLower),
              inArray(pmStakes.marketId, marketIds),
            ),
          );
  const stakesByMarketId = new Map<
    number,
    Array<{ optionIndex: number; amount: string }>
  >();
  for (const s of stakeRows) {
    const mid = Number(s.marketId);
    const arr = stakesByMarketId.get(mid) ?? [];
    arr.push({ optionIndex: s.optionIndex, amount: s.amount });
    stakesByMarketId.set(mid, arr);
  }

  // Step 4: pm_claims batch (wallet-scoped).
  __recordDbCall('claims');
  const claimRows =
    marketIds.length === 0
      ? []
      : await db
          .select()
          .from(pmClaims)
          .where(
            and(
              eq(pmClaims.chainId, args.chainId),
              eq(pmClaims.contractAddress, contractLower),
              eq(pmClaims.recipient, walletLower),
              inArray(pmClaims.marketId, marketIds),
            ),
          );
  const claimsByMarketId = new Map<number, string[]>();
  for (const c of claimRows) {
    const mid = Number(c.marketId);
    const arr = claimsByMarketId.get(mid) ?? [];
    arr.push(c.amount);
    claimsByMarketId.set(mid, arr);
  }

  // Multicall getPendingClaim for every candidate (batched, fail-open).
  // Codex 2B-6 r1 M1: a transport-level rejection (RPC 500, network
  // drop, timeout) — distinct from per-call `{status:'failure'}` —
  // must NOT throw out of this helper. Wrap each batch in try/catch
  // and treat the whole batch as failed reads. UI still gets rows
  // (with pendingAmountOnChain=null) instead of a 500.
  const readAttemptCount = candidates.length;
  let readFailureCount = 0;
  const pendingByMarketId = new Map<number, string | null>();
  for (let i = 0; i < candidates.length; i += multicallBatchSize) {
    const batch = candidates.slice(i, i + multicallBatchSize);
    const contracts = batch
      .filter((c): c is typeof c & { marketId: number } => c.marketId !== null)
      .map((c) => ({
        address: contractLower as `0x${string}`,
        abi: privateMarketsAbi,
        functionName: 'getPendingClaim' as const,
        args: [BigInt(c.marketId), walletLower as `0x${string}`] as const,
      }));
    let results:
      | ReadonlyArray<
          { status: 'success'; result: bigint } | { status: 'failure' }
        >
      | null = null;
    let batchErrorName: string | null = null;
    let batchErrorMessage: string | null = null;
    try {
      results = (await args.publicClient.multicall({
        allowFailure: true,
        contracts: contracts as never,
      })) as ReadonlyArray<
        { status: 'success'; result: bigint } | { status: 'failure' }
      >;
    } catch (err: unknown) {
      // Codex 2B-6 r2 m1: keep the root-cause string in the
      // observation so production can distinguish "RPC timeout"
      // from "ABI encoding bug". Truncate to bound log lines.
      results = null;
      if (err instanceof Error) {
        batchErrorName = err.name;
        batchErrorMessage = (err.message ?? '').slice(0, 500);
      } else {
        batchErrorName = 'NonError';
        try {
          batchErrorMessage = String(err).slice(0, 500);
        } catch {
          batchErrorMessage = '<unstringifiable>';
        }
      }
    }
    for (let j = 0; j < contracts.length; j++) {
      const c = batch[j];
      if (c.marketId === null) continue;
      const r = results === null ? { status: 'failure' as const } : results[j];
      if (r.status === 'success') {
        pendingByMarketId.set(c.marketId, r.result.toString());
      } else {
        pendingByMarketId.set(c.marketId, null);
        readFailureCount++;
        logObservation('pending-claim-read-failed', {
          component: 'pm-query',
          handler: 'getPendingClaimsForWallet',
          chainId: args.chainId,
          contractAddress: contractLower,
          marketId: c.marketId,
          ...(batchErrorName !== null
            ? {
                errorName: batchErrorName,
                errorMessage: batchErrorMessage,
                failureMode: 'transport',
              }
            : { failureMode: 'per-call' }),
        });
      }
    }
  }

  // Aggregate chainReadStatus.
  const chainReadStatus: PendingClaimsResult['chainReadStatus'] =
    readAttemptCount === 0
      ? 'ok'
      : readFailureCount === 0
        ? 'ok'
        : readFailureCount === readAttemptCount
          ? 'failed'
          : 'degraded';

  // Assemble + filter.
  const rows: PendingClaimRow[] = [];
  for (const candidate of candidates) {
    const opts = optionsByDbId.get(candidate.id) ?? [];
    const market = rowToView(candidate, opts);
    const stateAt = effectiveState(
      {
        currentState: candidate.currentState,
        stakingOpensAt: candidate.stakingOpensAt,
        closeAt: candidate.closeAt,
        totalStake: candidate.totalStake,
      },
      args.now,
    );
    const stakesForRow =
      candidate.marketId === null
        ? []
        : stakesByMarketId.get(candidate.marketId) ?? [];
    const claimAmounts =
      candidate.marketId === null
        ? []
        : claimsByMarketId.get(candidate.marketId) ?? [];
    const alreadyClaimedFromAudit = claimAmounts
      .reduce((acc, x) => acc + parseNonNegativeDecimal(x), 0n)
      .toString();
    const pendingAmountOnChain =
      candidate.marketId === null
        ? null
        : pendingByMarketId.get(candidate.marketId) ?? null;

    // Filter (Codex r4 m1: parseNonNegativeDecimal everywhere).
    const include = ((): boolean => {
      if (pendingAmountOnChain === null) return true; // failed read
      const pendingBig = parseNonNegativeDecimal(pendingAmountOnChain);
      if (pendingBig > 0n) return true;
      const claimedBig = parseNonNegativeDecimal(alreadyClaimedFromAudit);
      if (
        includePending &&
        (stateAt === 'created' ||
          stateAt === 'open' ||
          stateAt === 'awaiting_creator')
      ) {
        return true;
      }
      if (includeFullyClaimed && claimedBig > 0n) return true;
      return false;
    })();
    if (!include) continue;

    rows.push({
      market,
      effectiveStateAt: stateAt,
      pendingAmountOnChain,
      alreadyClaimedFromAudit,
      stakes: stakesForRow,
    });
  }

  return {
    rows,
    truncated,
    candidateCap,
    readAttemptCount,
    readFailureCount,
    chainReadStatus,
  };
}

// ---- Listing helpers -------------------------------------------------------

async function fetchPaginatedMarketRows(args: {
  chainId: number;
  contractAddress: `0x${string}`;
  whereExtra: ReturnType<typeof and>;
  now: Date;
  effectiveStateFilter?: EffectiveState[];
  limit: number;
  offset: number;
  candidateCap: number;
}): Promise<PaginatedMarketRows> {
  assertPositiveInt('limit', args.limit);
  assertNonNegativeInt('offset', args.offset);
  assertPositiveInt('candidateCap', args.candidateCap);
  const contractLower = normalizeHex(args.contractAddress, 20);
  // Fetch up to candidateCap+1 to detect truncation.
  const rawRows = await db
    .select()
    .from(pmMarkets)
    .where(
      and(
        eq(pmMarkets.chainId, args.chainId),
        eq(pmMarkets.contractAddress, contractLower),
        eq(pmMarkets.createStatus, 'confirmed'),
        args.whereExtra,
      ),
    )
    .orderBy(desc(pmMarkets.confirmedAt), desc(pmMarkets.marketId))
    .limit(args.candidateCap + 1);

  const truncated = rawRows.length > args.candidateCap;
  const candidates = rawRows.slice(0, args.candidateCap);

  if (candidates.length === 0) {
    return {
      rows: [],
      totalCount: 0,
      truncated,
      candidateCap: args.candidateCap,
    };
  }

  // Hydrate options in one query.
  const marketDbIds = candidates.map((c) => c.id);
  const optionRows = await db
    .select()
    .from(pmOptions)
    .where(inArray(pmOptions.marketDbId, marketDbIds));
  const optionsByDbId = new Map<string, typeof pmOptions.$inferSelect[]>();
  for (const o of optionRows) {
    const arr = optionsByDbId.get(o.marketDbId) ?? [];
    arr.push(o);
    optionsByDbId.set(o.marketDbId, arr);
  }

  // Compute + filter.
  const filtered: PaginatedMarketRow[] = [];
  for (const c of candidates) {
    const market = rowToView(c, optionsByDbId.get(c.id) ?? []);
    const stateAt = effectiveState(
      {
        currentState: c.currentState,
        stakingOpensAt: c.stakingOpensAt,
        closeAt: c.closeAt,
        totalStake: c.totalStake,
      },
      args.now,
    );
    if (
      args.effectiveStateFilter &&
      args.effectiveStateFilter.length > 0 &&
      !args.effectiveStateFilter.includes(stateAt)
    ) {
      continue;
    }
    filtered.push({ market, effectiveStateAt: stateAt });
  }

  return {
    rows: filtered.slice(args.offset, args.offset + args.limit),
    totalCount: filtered.length,
    truncated,
    candidateCap: args.candidateCap,
  };
}

export async function getMarketsCreatedByWallet(args: {
  chainId: number;
  contractAddress: `0x${string}`;
  wallet: `0x${string}`;
  now: Date;
  limit?: number;
  offset?: number;
  candidateCap?: number;
}): Promise<PaginatedMarketRows> {
  const walletLower = normalizeHex(args.wallet, 20);
  return fetchPaginatedMarketRows({
    chainId: args.chainId,
    contractAddress: args.contractAddress,
    whereExtra: and(eq(pmMarkets.creator, walletLower)),
    now: args.now,
    limit: args.limit ?? DEFAULT_LIMIT,
    offset: args.offset ?? 0,
    candidateCap: args.candidateCap ?? DEFAULT_CANDIDATE_CAP,
  });
}

export async function getMarketsForWalletByEffectiveState(args: {
  chainId: number;
  contractAddress: `0x${string}`;
  wallet: `0x${string}`;
  now: Date;
  effectiveStateFilter?: EffectiveState[];
  limit?: number;
  offset?: number;
  candidateCap?: number;
}): Promise<PaginatedMarketRows> {
  const walletLower = normalizeHex(args.wallet, 20);
  const contractLower = normalizeHex(args.contractAddress, 20);
  // Same EXISTS-or-EXISTS logic as getPendingClaimsForWallet.
  const stakerExists = sql`EXISTS (
    SELECT 1 FROM ${pmStakes}
     WHERE ${pmStakes.chainId} = ${args.chainId}
       AND ${pmStakes.contractAddress} = ${contractLower}
       AND ${pmStakes.staker} = ${walletLower}
       AND ${pmStakes.marketId} = ${pmMarkets.marketId}
  )`;
  const participantExists = sql`EXISTS (
    SELECT 1 FROM ${pmOptions}
     WHERE ${pmOptions.marketDbId} = ${pmMarkets.id}
       AND ${pmOptions.participantWallet} = ${walletLower}
  )`;
  return fetchPaginatedMarketRows({
    chainId: args.chainId,
    contractAddress: args.contractAddress,
    whereExtra: and(or(stakerExists, participantExists)),
    now: args.now,
    effectiveStateFilter: args.effectiveStateFilter,
    limit: args.limit ?? DEFAULT_LIMIT,
    offset: args.offset ?? 0,
    candidateCap: args.candidateCap ?? DEFAULT_CANDIDATE_CAP,
  });
}

void exists;
void asc;
