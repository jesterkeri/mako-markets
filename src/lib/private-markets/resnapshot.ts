import 'server-only';

// ----------------------------------------------------------------------------
// src/lib/private-markets/resnapshot.ts
//
// Phase 2B-5: canonical-metadata refresh + orphan-resolution recovery
// + pool_total reconciliation. Driven by /api/cron/pm-maintenance every
// 5 minutes.
//
// SCOPE OF MUTATION:
//   - title, description, streamUrl, dust, totalStake, feeTaken
//   - pm_options.label, pm_options.participantWallet
//   - frozenAt (mirror MetadataFrozen recovery)
//   - pool_total (reconcile via SUM(pm_stakes.amount) under FOR UPDATE
//     row lock so concurrent processStaked increments serialise behind us)
//   - firstStakeSequence (re-fetch when NULL but stakes exist)
//   - current_state (NARROW exception: orphan-resolution recovery only —
//     when current_state='created' AND chain says terminal AND exactly
//     one pm_resolutions row at-or-before watermark derives to the same
//     terminal state)
//
// State-divergence cases that DO NOT mutate current_state but log alerts:
//   - audit-vs-chain disagreement (alert state-mismatch)
//   - multiple matching audit rows (alert state-mismatch ambiguity)
//   - terminal-A vs terminal-B (alert state-mismatch)
//   - terminal-A vs created/open (alert state-mismatch chain-reorg?)
//
// State-divergence cases that silent-skip (NOT alert):
//   - current_state='created' + chain terminal + zero matching audit rows
//     (indexer behind watermark; pm.metric resnapshot-state-deferred line)
//   - current_state matches chain (no-op)
// ----------------------------------------------------------------------------

import { and, asc, eq, isNull, lt, lte, or, sql } from 'drizzle-orm';
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

import { alertInvariantViolation, logMetric } from './alerting';
import {
  bigintToNumber,
  bytesToUtf8,
  normalizeHex,
  secondsBigIntToDate,
} from './normalize';

// ---- Types -----------------------------------------------------------------

export interface ResnapshotConfirmedArgs {
  db: DbOrTx;
  publicClient: PublicClient;
  contractAddress: `0x${string}`;
  chainId: number;
  /// Injectable for tests; defaults to `new Date()` in production.
  now: Date;
  /// Maximum age (ms) of `updated_at` before a terminal-state row is
  /// eligible for resnapshot. Active-state rows (`current_state='created'`)
  /// bypass this gate and are eligible every tick.
  maxAgeMs: number;
  /// Per-tick batch limit. Shared between active + terminal rows;
  /// ordering is `updated_at ASC`.
  limit: number;
  /// Multicall batch size for the per-row prefetch reads.
  multicallBatchSize: number;
}

export interface ResnapshotConfirmedResult {
  resnapped: number;
  skipped: number;
}

/// Numeric `effectiveState` returned by the contract's `getMarket()`.
/// Matches MakoPrivateMarketsV1.sol MarketState enum.
const EFFECTIVE_STATE = {
  Created: 0,
  Open: 1,
  AwaitingCreator: 2,
  Resolved: 3,
  EmptyPoolResolved: 4,
  Canceled: 5,
  TimedOut: 6,
  ZeroStakeExpired: 7,
} as const;

const TERMINAL_STATES = new Set<number>([
  EFFECTIVE_STATE.Resolved,
  EFFECTIVE_STATE.EmptyPoolResolved,
  EFFECTIVE_STATE.Canceled,
  EFFECTIVE_STATE.TimedOut,
  EFFECTIVE_STATE.ZeroStakeExpired,
]);

type PmMarketStateEnum =
  | 'created'
  | 'resolved'
  | 'empty_pool_resolved'
  | 'canceled'
  | 'timed_out'
  | 'zero_stake_expired';

function effectiveStateToEnum(
  effectiveState: number,
): PmMarketStateEnum | null {
  switch (effectiveState) {
    case EFFECTIVE_STATE.Resolved:
      return 'resolved';
    case EFFECTIVE_STATE.EmptyPoolResolved:
      return 'empty_pool_resolved';
    case EFFECTIVE_STATE.Canceled:
      return 'canceled';
    case EFFECTIVE_STATE.TimedOut:
      return 'timed_out';
    case EFFECTIVE_STATE.ZeroStakeExpired:
      return 'zero_stake_expired';
    default:
      return null;
  }
}

interface AuditRowDerivedState {
  /// pm_resolutions row id (composite (txHash, logIndex)) — used in
  /// logs for traceability.
  txHash: string;
  logIndex: number;
  eventName: string;
  payload: Record<string, unknown>;
  derivedState: PmMarketStateEnum;
}

/// Map a `pm_resolutions.event_name` + payload onto the terminal
/// `pm_market_state` enum the contract would have set on observation.
function deriveStateFromAuditRow(
  eventName: string,
  payload: Record<string, unknown>,
): PmMarketStateEnum | null {
  if (eventName === 'ResolvedFriendly') {
    const emptyPoolPath = payload.emptyPoolPath === true;
    return emptyPoolPath ? 'empty_pool_resolved' : 'resolved';
  }
  if (eventName === 'ResolvedOpenVote') return 'resolved';
  if (eventName === 'DistributedPrizePool') return 'resolved';
  if (eventName === 'Canceled') {
    const reason = payload.reason;
    if (reason === 0) return 'canceled';
    if (reason === 1) return 'timed_out';
    if (reason === 2) return 'zero_stake_expired';
    // Unknown reason → no derived state. The original handler emitted
    // an `unknown-reason` alert; resnapshot does not get a second bite.
    return null;
  }
  return null;
}

// ---- View struct shape (mirrors indexer.ts MarketViewLike) -----------------

interface MarketViewLike {
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

interface FetchedRowMetadata {
  market: MarketViewLike;
  title: string;
  description: string;
  streamUrl: string;
  optionLabels: string[];
  participants: `0x${string}`[];
}

// ---- Main entry ------------------------------------------------------------

export async function resnapshotConfirmed(
  args: ResnapshotConfirmedArgs,
): Promise<ResnapshotConfirmedResult> {
  const {
    db,
    publicClient,
    contractAddress,
    chainId,
    now,
    maxAgeMs,
    limit,
    multicallBatchSize,
  } = args;

  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RangeError(
      `resnapshotConfirmed: limit must be a positive integer; got ${limit}`,
    );
  }
  if (
    !Number.isInteger(multicallBatchSize) ||
    multicallBatchSize <= 0
  ) {
    throw new RangeError(
      `resnapshotConfirmed: multicallBatchSize must be a positive integer`,
    );
  }
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    throw new RangeError(
      `resnapshotConfirmed: maxAgeMs must be non-negative`,
    );
  }

  const contractAddressLower = normalizeHex(contractAddress, 20);
  const cutoffDate = new Date(now.getTime() - maxAgeMs);

  // Read indexer watermark for state-deferred / orphan-recovery
  // gating.
  const indexerStateRows = await db
    .select({ lastIndexedBlock: pmIndexerState.lastIndexedBlock })
    .from(pmIndexerState)
    .where(eq(pmIndexerState.chainId, chainId))
    .limit(1);
  const lastIndexedBlock =
    indexerStateRows.length > 0
      ? Number(indexerStateRows[0].lastIndexedBlock)
      : 0;

  // Selection criteria: confirmed rows where either updated_at is
  // older than maxAge OR current_state='created' (active rows
  // resnapshot every tick — Codex r2 m1).
  const candidates = await db
    .select({
      id: pmMarkets.id,
      marketId: pmMarkets.marketId,
      currentState: pmMarkets.currentState,
      shape: pmMarkets.shape,
    })
    .from(pmMarkets)
    .where(
      and(
        eq(pmMarkets.chainId, chainId),
        eq(pmMarkets.contractAddress, contractAddressLower),
        eq(pmMarkets.createStatus, 'confirmed'),
        or(
          lt(pmMarkets.updatedAt, cutoffDate),
          eq(pmMarkets.currentState, 'created'),
        ),
      ),
    )
    .orderBy(asc(pmMarkets.updatedAt))
    .limit(limit);

  if (candidates.length === 0) {
    return { resnapped: 0, skipped: 0 };
  }

  // Phase B: multicall prefetch per row, batched.
  // Drizzle's `bigint mode:number` may surface as string under pglite;
  // coerce defensively to keep the BigInt() / SQL parameter sites
  // numeric.
  const candidatesWithMarketId = candidates
    .map((c) => ({
      ...c,
      marketId:
        c.marketId === null || c.marketId === undefined
          ? null
          : Number(c.marketId),
    }))
    .filter(
      (c): c is typeof c & { marketId: number } =>
        c.marketId !== null && Number.isFinite(c.marketId),
    );
  const fetched = new Map<number, FetchedRowMetadata>();
  for (
    let i = 0;
    i < candidatesWithMarketId.length;
    i += multicallBatchSize
  ) {
    const batch = candidatesWithMarketId.slice(
      i,
      i + multicallBatchSize,
    );
    const contracts = batch.flatMap((c) => {
      const mid = BigInt(c.marketId);
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
          functionName: 'getMarketParticipants' as const,
          args: [mid] as const,
        },
      ];
    });
    const results = (await publicClient.multicall({
      allowFailure: false,
      contracts: contracts as never,
    })) as readonly unknown[];

    for (let j = 0; j < batch.length; j++) {
      const c = batch[j];
      const base = j * 6;
      const market = results[base] as MarketViewLike;
      const titleBytes = results[base + 1] as `0x${string}`;
      const descBytes = results[base + 2] as `0x${string}`;
      const streamBytes = results[base + 3] as `0x${string}`;
      const optionLabelBytes = results[base + 4] as readonly `0x${string}`[];
      const participants = results[base + 5] as readonly `0x${string}`[];

      fetched.set(c.marketId, {
        market,
        title: bytesToUtf8(titleBytes).value,
        description: bytesToUtf8(descBytes).value,
        streamUrl: bytesToUtf8(streamBytes).value,
        optionLabels: optionLabelBytes.map((b) => bytesToUtf8(b).value),
        participants: participants.map((a) => normalizeHex(a, 20)),
      });
    }
  }

  // Phase C: per-row transaction with mutation rules + state-divergence
  // alerting. Each row's reconciliation is an independent transaction
  // so a failure on one row leaves others intact.
  let resnapped = 0;
  let skipped = 0;
  for (const c of candidatesWithMarketId) {
    const meta = fetched.get(c.marketId);
    if (!meta) {
      skipped += 1;
      continue;
    }
    try {
      const handled = await reconcileOneRow({
        db,
        publicClient,
        chainId,
        contractAddress: contractAddressLower,
        contractAddressOriginal: contractAddress,
        marketDbId: c.id,
        marketId: c.marketId,
        currentState: c.currentState,
        meta,
        lastIndexedBlock,
        now,
      });
      if (handled) resnapped += 1;
      else skipped += 1;
    } catch {
      // Failure on one row leaves others intact. The thrown error
      // would already have been logged by an inner alert/log helper
      // if it originated from a known soft-fail path.
      skipped += 1;
    }
  }

  logMetric('resnapshot', {
    component: 'pm-maintenance',
    handler: 'resnapshotConfirmed',
    chainId,
    contractAddress: contractAddressLower,
    resnapped,
    skipped,
  });

  return { resnapped, skipped };
}

// ---- Per-row reconciliation -----------------------------------------------

interface ReconcileOneRowArgs {
  db: DbOrTx;
  publicClient: PublicClient;
  chainId: number;
  contractAddress: `0x${string}`;
  /// The original-cased address as passed by the caller. Used in log
  /// payloads for parity with handler emissions.
  contractAddressOriginal: `0x${string}`;
  marketDbId: string;
  marketId: number;
  currentState: PmMarketStateEnum;
  meta: FetchedRowMetadata;
  lastIndexedBlock: number;
  now: Date;
}

async function reconcileOneRow(
  args: ReconcileOneRowArgs,
): Promise<boolean> {
  const {
    db,
    publicClient,
    chainId,
    contractAddress,
    marketDbId,
    marketId,
    currentState,
    meta,
    lastIndexedBlock,
    now,
  } = args;
  const chainEffectiveStateNum = meta.market.effectiveState;
  const chainEffectiveStateEnum = effectiveStateToEnum(
    chainEffectiveStateNum,
  );
  // Note: `Open` / `AwaitingCreator` lazy states never persist in
  // pm_markets; chain may report them but they map to the local
  // `'created'` baseline.

  // -- State-divergence triage -------------------------------------------
  const localTerminal = currentState !== 'created';
  const chainTerminal = TERMINAL_STATES.has(chainEffectiveStateNum);

  let didOrphanRecovery = false;
  if (currentState === 'created' && chainTerminal) {
    // Either orphan-resolution recovery, indexer-behind silent skip,
    // or audit-vs-chain disagreement / ambiguity. Resolve via the
    // pm_resolutions audit rows at-or-before watermark.
    const audits = await db
      .select({
        txHash: pmResolutions.txHash,
        logIndex: pmResolutions.logIndex,
        eventName: pmResolutions.eventName,
        payload: pmResolutions.payload,
      })
      .from(pmResolutions)
      .where(
        and(
          eq(pmResolutions.chainId, chainId),
          eq(pmResolutions.contractAddress, contractAddress),
          eq(pmResolutions.marketId, marketId),
          lte(pmResolutions.blockNumber, lastIndexedBlock),
        ),
      );

    const derived: AuditRowDerivedState[] = audits
      .map((row) => {
        const payload = (row.payload ?? {}) as Record<string, unknown>;
        const ds = deriveStateFromAuditRow(row.eventName, payload);
        return ds === null
          ? null
          : {
              txHash: row.txHash,
              logIndex: row.logIndex,
              eventName: row.eventName,
              payload,
              derivedState: ds,
            };
      })
      .filter((row): row is AuditRowDerivedState => row !== null);

    const matches = derived.filter(
      (row) => row.derivedState === chainEffectiveStateEnum,
    );

    if (audits.length === 0) {
      // No audit rows at-or-before watermark — indexer hasn't seen the
      // event yet. Silent skip (NOT an alert per Codex r1 M4).
      logMetric('resnapshot-state-deferred', {
        component: 'pm-maintenance',
        handler: 'resnapshotConfirmed',
        chainId,
        contractAddress,
        marketId,
        chainEffectiveState: chainEffectiveStateNum,
        lastIndexedBlock,
      });
      // Still refresh the non-state metadata fields below.
    } else if (matches.length === 1) {
      // Codex r3 M1/M2: orphan-resolution recovery happy path.
      // Codex r4 m2: count===1 even when there are additional
      // mismatching audit rows (older reorg artefacts). The single
      // match is authoritative.
      // Codex 2B-5 r1 M2: predicate-guarded UPDATE inside
      // applyOrphanRecovery; if a concurrent pm-indexer tick
      // terminalised the row between our SELECT and the UPDATE,
      // applied:false → treat as state-mismatch.
      const m = matches[0];
      const recovery = await applyOrphanRecovery({
        db,
        marketDbId,
        derivedState: m.derivedState,
        payload: m.payload,
        now,
      });
      if (recovery.applied) {
        logMetric('resnapshot-orphan-recovery', {
          component: 'pm-maintenance',
          handler: 'resnapshotConfirmed',
          chainId,
          contractAddress,
          marketId,
          eventName: m.eventName,
          derivedState: m.derivedState,
          auditRowCount: audits.length,
        });
        didOrphanRecovery = true;
      } else {
        // The row's current_state changed under us between SELECT
        // and the predicate-guarded UPDATE. Surface as state-mismatch.
        alertInvariantViolation('state-mismatch', {
          component: 'pm-maintenance',
          handler: 'resnapshotConfirmed',
          chainId,
          contractAddress,
          marketId,
          reason: 'concurrent-state-change',
          eventName: m.eventName,
          derivedState: m.derivedState,
        });
      }
    } else if (matches.length === 0) {
      // Audit row(s) present but none match chain — chain reorg or
      // contract/operator drift. Alert; do NOT mutate.
      alertInvariantViolation('state-mismatch', {
        component: 'pm-maintenance',
        handler: 'resnapshotConfirmed',
        chainId,
        contractAddress,
        marketId,
        reason: 'audit-chain-disagreement',
        chainEffectiveState: chainEffectiveStateNum,
        chainEffectiveStateEnum,
        auditRowCount: audits.length,
      });
    } else {
      // matches.length >= 2 — multi-audit-row ambiguity.
      alertInvariantViolation('state-mismatch', {
        component: 'pm-maintenance',
        handler: 'resnapshotConfirmed',
        chainId,
        contractAddress,
        marketId,
        reason: 'audit-row-ambiguity',
        chainEffectiveState: chainEffectiveStateNum,
        chainEffectiveStateEnum,
        auditRowCount: audits.length,
        matchingAuditRowCount: matches.length,
      });
    }
  } else if (
    localTerminal &&
    chainEffectiveStateEnum !== currentState
  ) {
    // Local says terminal-A, chain says terminal-B (or 'created' /
    // lazy state). Either case: alert, never mutate.
    alertInvariantViolation('state-mismatch', {
      component: 'pm-maintenance',
      handler: 'resnapshotConfirmed',
      chainId,
      contractAddress,
      marketId,
      reason: 'local-terminal-vs-chain-divergent',
      localState: currentState,
      chainEffectiveState: chainEffectiveStateNum,
      chainEffectiveStateEnum,
    });
  }
  // currentState === 'created' && !chainTerminal → no divergence yet.
  // localTerminal && chainEffectiveStateEnum === currentState → match, no-op.

  // -- Non-state metadata refresh ----------------------------------------
  await db
    .update(pmMarkets)
    .set({
      title: meta.title,
      description: meta.description,
      streamUrl: meta.streamUrl,
      dust: meta.market.dust.toString(),
      totalStake: meta.market.totalStake.toString(),
      feeTaken: meta.market.feeTaken.toString(),
      // Timestamps + visibility flags. Backfill path for rows whose
      // confirmed-flip predates the indexer fix that writes these on
      // MarketCreated. Reading from `meta.market` (getMarket() view)
      // is the canonical source; writing on every resnapshot is
      // idempotent for already-correct rows.
      stakingOpensAt: secondsBigIntToDate(meta.market.stakingOpensAt),
      closeAt: secondsBigIntToDate(meta.market.closeAt),
      visibilityView: meta.market.viewMode,
      visibilityParticipation: meta.market.participationMode,
      frozenAt: meta.market.metadataFrozenEmitted
        ? sql`COALESCE(${pmMarkets.frozenAt}, NOW())`
        : null,
      updatedAt: now,
    })
    .where(eq(pmMarkets.id, marketDbId));

  // -- pm_options refresh: labels + participants -------------------------
  for (let i = 0; i < meta.optionLabels.length; i++) {
    const label = meta.optionLabels[i];
    const participantWallet = meta.participants[i] ?? null;
    await db
      .update(pmOptions)
      .set({ label, participantWallet })
      .where(
        and(
          eq(pmOptions.marketDbId, marketDbId),
          eq(pmOptions.optionIndex, i),
        ),
      );
  }

  // -- pool_total reconciliation under FOR UPDATE row-lock --------------
  // Codex r3 m3: lock pm_options first, then SUM(pm_stakes.amount), then
  // UPDATE. Concurrent processStaked increments serialise behind the lock.
  await reconcilePoolTotal({
    db,
    chainId,
    contractAddress,
    marketDbId,
    marketId,
  });

  // -- firstStakeSequence recovery for NULL pool entries -----------------
  // Codex 2B-5 r1 M1: when an orphan Staked event landed before its
  // parent MarketCreated, processStaked observed `firstStakeSequence`
  // skip-write (no pm_options row). After MarketCreated arrives the
  // pm_options row exists with `firstStakeSequence = NULL`, but the
  // event-handler path doesn't get a second bite. Resnapshot reads
  // `getOptionFirstStakeSequence(marketId, optionIndex)` for any
  // pm_options row where `firstStakeSequence IS NULL` AND a
  // corresponding pm_stakes row exists, then writes-once-and-set
  // (predicated on `firstStakeSequence IS NULL` so a concurrent
  // event-handler write isn't overwritten).
  await reconcileFirstStakeSequence({
    db,
    publicClient,
    chainId,
    contractAddress,
    marketDbId,
    marketId,
  });

  return true;
  // Suppress unused-var warning — `didOrphanRecovery` is the metric
  // hook; kept as a local for future log-aggregation promotion
  // (Codex 2B-5 r1 n1 — Sentry comment removed).
  void didOrphanRecovery;
}

interface ApplyOrphanRecoveryArgs {
  db: DbOrTx;
  marketDbId: string;
  derivedState: PmMarketStateEnum;
  payload: Record<string, unknown>;
  now: Date;
}

interface ApplyOrphanRecoveryResult {
  /// True iff the predicate-guarded UPDATE actually wrote a row. False
  /// indicates a concurrent pm-indexer tick terminalised the row
  /// between our SELECT and this UPDATE — caller should treat as a
  /// state-mismatch (no-op on this resnapshot pass).
  applied: boolean;
}

async function applyOrphanRecovery(
  args: ApplyOrphanRecoveryArgs,
): Promise<ApplyOrphanRecoveryResult> {
  const { db, marketDbId, derivedState, payload, now } = args;
  // Codex 2B-5 r1 M2: predicate-guard the mirror UPDATE on
  // current_state='created'. The earlier flow read current_state from
  // the prefetch SELECT; without the WHERE-clause guard, a concurrent
  // pm-indexer tick that terminalised the row between selection and
  // recovery would be silently overwritten. The .returning() length
  // tells us whether the UPDATE matched — zero rows means the row
  // was already terminal-or-different, and the caller must treat
  // this as state-mismatch.
  const friendlyOutcomeRaw = payload.outcome;
  const friendlyOutcome =
    derivedState === 'resolved' || derivedState === 'empty_pool_resolved'
      ? friendlyOutcomeRaw === 0 || friendlyOutcomeRaw === 1
        ? friendlyOutcomeRaw
        : null
      : null;
  const friendlyEmptyPoolPath =
    derivedState === 'empty_pool_resolved'
      ? true
      : derivedState === 'resolved'
        ? payload.emptyPoolPath === true
          ? true
          : payload.emptyPoolPath === false
            ? false
            : null
        : null;
  const feeTakenStr =
    derivedState === 'canceled' ||
    derivedState === 'timed_out' ||
    derivedState === 'zero_stake_expired'
      ? '0'
      : typeof payload.feeTaken === 'string'
        ? payload.feeTaken
        : '0';

  const updated = await db
    .update(pmMarkets)
    .set({
      currentState: derivedState,
      friendlyOutcome,
      friendlyEmptyPoolPath,
      feeTaken: feeTakenStr,
      updatedAt: now,
    })
    .where(
      and(
        eq(pmMarkets.id, marketDbId),
        eq(pmMarkets.currentState, 'created'),
      ),
    )
    .returning({ id: pmMarkets.id });

  return { applied: updated.length > 0 };
}

interface ReconcilePoolTotalArgs {
  db: DbOrTx;
  chainId: number;
  contractAddress: `0x${string}`;
  marketDbId: string;
  marketId: number;
}

async function reconcilePoolTotal(
  args: ReconcilePoolTotalArgs,
): Promise<void> {
  const { db, chainId, contractAddress, marketDbId, marketId } = args;
  // Codex r3 m3 + r4 m3: same-transaction sequence:
  //   1. SELECT id FROM pm_options FOR UPDATE (row-lock all option rows
  //      for this market)
  //   2. SELECT SUM(amount) FROM pm_stakes per option_index
  //   3. UPDATE pm_options SET pool_total = $sum
  // The .transaction wrapper provides BEGIN/COMMIT envelope; pglite +
  // postgres-js both honour it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db as any).transaction(async (tx: DbOrTx) => {
    // Step 1: row-lock pm_options for the target market.
    // pm_options has a composite PK on (market_db_id, option_index)
    // — there's no `id` column. SELECT 1 is sufficient to acquire
    // the row lock.
    await tx.execute(sql`
      SELECT 1 FROM pm_options
       WHERE market_db_id = ${marketDbId}
         FOR UPDATE
    `);

    // Step 2 + 3: per-option SUM + UPDATE.
    const options = await tx
      .select({ optionIndex: pmOptions.optionIndex })
      .from(pmOptions)
      .where(eq(pmOptions.marketDbId, marketDbId));
    for (const opt of options) {
      const sumResult = await tx.execute(sql`
        SELECT COALESCE(SUM(amount), 0)::text AS sum
          FROM pm_stakes
         WHERE chain_id = ${chainId}
           AND contract_address = ${contractAddress}
           AND market_id = ${marketId}
           AND option_index = ${opt.optionIndex}
      `);
      const raw =
        (sumResult as unknown as { rows?: unknown[] }).rows ??
        (sumResult as unknown as unknown[]);
      const row = (raw as Record<string, unknown>[])[0] ?? {};
      const sumStr = (row.sum as string | null) ?? '0';
      await tx
        .update(pmOptions)
        .set({ poolTotal: sumStr })
        .where(
          and(
            eq(pmOptions.marketDbId, marketDbId),
            eq(pmOptions.optionIndex, opt.optionIndex),
          ),
        );
    }
  });

  void pmStakes;
}

// ---- firstStakeSequence recovery (Codex 2B-5 r1 M1) -----------------------

interface ReconcileFirstStakeSequenceArgs {
  db: DbOrTx;
  publicClient: PublicClient;
  chainId: number;
  contractAddress: `0x${string}`;
  marketDbId: string;
  marketId: number;
}

async function reconcileFirstStakeSequence(
  args: ReconcileFirstStakeSequenceArgs,
): Promise<void> {
  const { db, publicClient, chainId, contractAddress, marketDbId, marketId } =
    args;

  // Find pm_options rows where firstStakeSequence is NULL AND there's
  // at least one pm_stakes row for the same option_index (proves a
  // stake actually landed; without this guard we'd hammer the chain
  // with reads for never-staked options).
  const candidates = await db
    .select({ optionIndex: pmOptions.optionIndex })
    .from(pmOptions)
    .where(
      and(
        eq(pmOptions.marketDbId, marketDbId),
        isNull(pmOptions.firstStakeSequence),
      ),
    );
  if (candidates.length === 0) return;

  // Filter to only options that have at least one stake.
  const optionsWithStakes: number[] = [];
  for (const opt of candidates) {
    const stakeProbe = await db
      .select({ optionIndex: pmStakes.optionIndex })
      .from(pmStakes)
      .where(
        and(
          eq(pmStakes.chainId, chainId),
          eq(pmStakes.contractAddress, contractAddress),
          eq(pmStakes.marketId, marketId),
          eq(pmStakes.optionIndex, opt.optionIndex),
        ),
      )
      .limit(1);
    if (stakeProbe.length > 0) {
      optionsWithStakes.push(opt.optionIndex);
    }
  }
  if (optionsWithStakes.length === 0) return;

  // Multicall getOptionFirstStakeSequence for all eligible options.
  const contracts = optionsWithStakes.map((optionIndex) => ({
    address: contractAddress,
    abi: privateMarketsAbi,
    functionName: 'getOptionFirstStakeSequence' as const,
    args: [BigInt(marketId), BigInt(optionIndex)] as const,
  }));
  const results = (await publicClient.multicall({
    allowFailure: false,
    contracts: contracts as never,
  })) as readonly unknown[];

  // Per-option write-once-and-set under `firstStakeSequence IS NULL`
  // predicate so a concurrent processStaked write isn't overwritten.
  for (let i = 0; i < optionsWithStakes.length; i++) {
    const tuple = results[i] as readonly [number, boolean];
    const sequence = bigintToNumber(BigInt(tuple[0]));
    const isSet = tuple[1];
    if (!isSet) continue; // Chain says no first-stake recorded yet.
    await db
      .update(pmOptions)
      .set({ firstStakeSequence: sequence })
      .where(
        and(
          eq(pmOptions.marketDbId, marketDbId),
          eq(pmOptions.optionIndex, optionsWithStakes[i]),
          isNull(pmOptions.firstStakeSequence),
        ),
      );
  }
}
