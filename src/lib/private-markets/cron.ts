import 'server-only';

// ----------------------------------------------------------------------------
// src/lib/private-markets/cron.ts
//
// Phase 2B-5: lib helpers behind /api/cron/pm-indexer and
// /api/cron/pm-maintenance. Routes are thin Bearer-auth wrappers over
// `runPmIndexerCron` and `runPmMaintenanceCron`.
//
// Codex r1 M2: route logic lives here so tests are caught by the
// `test:pm` glob (`vitest run src/lib/private-markets`).
// ----------------------------------------------------------------------------

import type { PublicClient } from 'viem';

import type { DbOrTx } from '@/db/client';

import { logCronError } from './alerting';
import {
  sweepStalePending,
  type SweepStalePendingResult,
} from './cleanup';
import {
  resnapshotConfirmed,
  type ResnapshotConfirmedResult,
} from './resnapshot';
import { runIndexerOnce, type RunIndexerResult } from './indexer';

// ---- pm-indexer ------------------------------------------------------------

export interface RunPmIndexerCronArgs {
  db: DbOrTx;
  publicClient: PublicClient;
  chainId: number;
  contractAddress: `0x${string}`;
  deployBlock: bigint;
  /// Injectable for tests; defaults to `new Date()` in production.
  now?: Date;
}

export interface RunPmIndexerCronResult {
  chainId: number;
  result: RunIndexerResult;
  durationMs: number;
}

export async function runPmIndexerCron(
  args: RunPmIndexerCronArgs,
): Promise<RunPmIndexerCronResult> {
  const { db, publicClient, chainId, contractAddress, deployBlock } = args;
  const t0 = Date.now();
  try {
    const result = await runIndexerOnce({
      chainId,
      contractAddress,
      deployBlock,
      db,
      publicClient,
    });
    return {
      chainId,
      result,
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logCronError('pm-indexer-failed', {
      component: 'pm-indexer',
      handler: 'runPmIndexerCron',
      chainId,
      contractAddress,
      errorMessage: message,
      error: err,
    });
    throw err;
  }
}

// ---- pm-maintenance --------------------------------------------------------

export interface RunPmMaintenanceCronArgs {
  db: DbOrTx;
  publicClient: PublicClient;
  chainId: number;
  contractAddress: `0x${string}`;
  /// Injectable for tests; defaults to `new Date()` in production.
  now?: Date;
  /// Stale-pending TTL. Default 1 hour.
  ttlMs?: number;
  /// Stale-pending sweep batch limit. Default 100.
  sweepLimit?: number;
  /// Resnapshot batch limit. Default 50.
  resnapshotLimit?: number;
  /// Resnapshot terminal-row decay (ms). Default 30 minutes.
  resnapshotMaxAgeMs?: number;
  /// Resnapshot multicall batch size. Default 10.
  resnapshotMulticallBatchSize?: number;
}

export interface RunPmMaintenanceCronResult {
  chainId: number;
  /// Stale-pending sweep result. `null` if the sweep threw.
  sweep: SweepStalePendingResult | null;
  sweepError?: string;
  /// Resnapshot result. `null` if the pass threw.
  resnapshot: ResnapshotConfirmedResult | null;
  resnapshotError?: string;
  durationMs: number;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_SWEEP_LIMIT = 100;
const DEFAULT_RESNAPSHOT_LIMIT = 50;
const DEFAULT_RESNAPSHOT_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_RESNAPSHOT_MULTICALL_BATCH_SIZE = 10;

export async function runPmMaintenanceCron(
  args: RunPmMaintenanceCronArgs,
): Promise<RunPmMaintenanceCronResult> {
  const {
    db,
    publicClient,
    chainId,
    contractAddress,
    now = new Date(),
    ttlMs = DEFAULT_TTL_MS,
    sweepLimit = DEFAULT_SWEEP_LIMIT,
    resnapshotLimit = DEFAULT_RESNAPSHOT_LIMIT,
    resnapshotMaxAgeMs = DEFAULT_RESNAPSHOT_MAX_AGE_MS,
    resnapshotMulticallBatchSize = DEFAULT_RESNAPSHOT_MULTICALL_BATCH_SIZE,
  } = args;

  const t0 = Date.now();
  let sweep: SweepStalePendingResult | null = null;
  let sweepError: string | undefined;
  let resnapshot: ResnapshotConfirmedResult | null = null;
  let resnapshotError: string | undefined;

  // Sub-phase B and C run independently so a failure on one does not
  // block the other (Codex r2 m3).
  try {
    sweep = await sweepStalePending(db, {
      chainId,
      contractAddress,
      now,
      ttlMs,
      limit: sweepLimit,
    });
  } catch (err) {
    sweepError = err instanceof Error ? err.message : String(err);
    logCronError('pm-maintenance-failed', {
      component: 'pm-maintenance',
      handler: 'sweepStalePending',
      chainId,
      contractAddress,
      errorMessage: sweepError,
      error: err,
    });
  }

  try {
    resnapshot = await resnapshotConfirmed({
      db,
      publicClient,
      contractAddress,
      chainId,
      now,
      maxAgeMs: resnapshotMaxAgeMs,
      limit: resnapshotLimit,
      multicallBatchSize: resnapshotMulticallBatchSize,
    });
  } catch (err) {
    resnapshotError = err instanceof Error ? err.message : String(err);
    logCronError('pm-maintenance-failed', {
      component: 'pm-maintenance',
      handler: 'resnapshotConfirmed',
      chainId,
      contractAddress,
      errorMessage: resnapshotError,
      error: err,
    });
  }

  return {
    chainId,
    sweep,
    sweepError,
    resnapshot,
    resnapshotError,
    durationMs: Date.now() - t0,
  };
}
