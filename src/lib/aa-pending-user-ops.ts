import 'server-only';

// ----------------------------------------------------------------------------
// src/lib/aa-pending-user-ops.ts
//
// Drizzle DAO for the `aa_pending_user_ops` table. Every transition is a
// single autocommit UPDATE gated on prior status — there are NO
// transactions across external RPC calls and NO `FOR UPDATE` locks.
// Concurrency is managed entirely by the partial unique index
// `aa_pending_one_in_flight (chain_id, safe_address) WHERE status IN
// ('pending','sending','submitted','ambiguous')`. If a transition's WHERE
// clause matches no row (rowCount === 0), another path beat us and the
// caller must reload + branch on the fresh status.
//
// Why this matters: holding a Postgres row lock across a Pimlico RPC
// (sponsor / send / receipt poll) means a flaky bundler stalls the DB
// connection until the lock times out, blocking unrelated routes that
// share the pool. The state-transition discipline below mirrors the lib's
// SendOutcome shape so the route can map outcomes to UPDATEs without
// re-interpreting errors.
// ----------------------------------------------------------------------------

import { and, eq, sql } from 'drizzle-orm';
import type { Address, Hex } from 'viem';

import { db, type DbOrTx } from '@/db/client';
import {
  aaPendingUserOps,
  type AaPendingUserOp,
  type AaPendingStatus,
} from '@/db/schema';
import type { StoredSplitFormUserOp } from './user-op-types';

/// Thrown when a status-gated UPDATE matches zero rows. The route maps this
/// to "reload + re-route through the status switch" — see the AlreadyClaimed
/// catch in /api/aa/send.
export class AlreadyClaimedError extends Error {
  constructor(public readonly rowId: string) {
    super(`aa_pending_user_ops row ${rowId} already claimed by another path`);
    this.name = 'AlreadyClaimedError';
  }
}

// ── insert ───────────────────────────────────────────────────────────────────

export type InsertPendingArgs = {
  userId: string;
  chainId: number;
  safeAddress: Address;
  magicEoa: Address;
  userOp: StoredSplitFormUserOp;
  nonceHex: Hex;
  safeOpHash: Hex;
  expiresAt: Date;
};

export type InsertPendingResult =
  | { kind: 'inserted'; id: string; expiresAt: Date }
  /// Partial unique index rejected — another in-flight row exists for
  /// `(chainId, safeAddress)`. Caller (sponsor route) reloads via
  /// `loadInFlightForSafe` and routes through `serializeExistingInFlight`.
  | { kind: 'conflict' };

/// Insert a row in `pending` state. Uses `ON CONFLICT DO NOTHING` against
/// the partial unique index — if the index already covers another in-flight
/// row for the same (chainId, safeAddress), the insert is a no-op and we
/// return `{ kind: 'conflict' }`. Lowercases address fields to satisfy the
/// CHECK constraints.
export async function insertPending(
  args: InsertPendingArgs,
  opts?: { tx?: DbOrTx },
): Promise<InsertPendingResult> {
  const writer = opts?.tx ?? db;
  const rows = await writer
    .insert(aaPendingUserOps)
    .values({
      userId: args.userId,
      chainId: args.chainId,
      safeAddress: args.safeAddress.toLowerCase(),
      magicEoa: args.magicEoa.toLowerCase(),
      userOp: args.userOp,
      nonceHex: args.nonceHex.toLowerCase() as Hex,
      safeOpHash: args.safeOpHash.toLowerCase() as Hex,
      status: 'pending',
      expiresAt: args.expiresAt,
    })
    .onConflictDoNothing()
    .returning({
      id: aaPendingUserOps.id,
      expiresAt: aaPendingUserOps.expiresAt,
    });
  if (rows.length === 0) return { kind: 'conflict' };
  return { kind: 'inserted', id: rows[0].id, expiresAt: rows[0].expiresAt };
}

// ── load ─────────────────────────────────────────────────────────────────────

/// Load a row by id + user_id (so cross-user reads always miss). Returns
/// null on miss; the route maps that to 404.
export async function loadById(args: {
  rowId: string;
  sessionUserId: string;
}): Promise<AaPendingUserOp | null> {
  const rows = await db
    .select()
    .from(aaPendingUserOps)
    .where(
      and(
        eq(aaPendingUserOps.id, args.rowId),
        eq(aaPendingUserOps.userId, args.sessionUserId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/// Look up the in-flight row (if any) for a given (chainId, safeAddress).
/// Mirrors the partial unique index. Used by both the precheck branch and
/// the INSERT race-loss branch in /api/aa/sponsor.
export async function loadInFlightForSafe(args: {
  chainId: number;
  safeAddress: Address;
}): Promise<AaPendingUserOp | null> {
  const rows = await db
    .select()
    .from(aaPendingUserOps)
    .where(
      and(
        eq(aaPendingUserOps.chainId, args.chainId),
        eq(aaPendingUserOps.safeAddress, args.safeAddress.toLowerCase()),
        sql`${aaPendingUserOps.status} IN ('pending','sending','submitted','ambiguous')`,
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

// ── transitions (each is a status-gated single-statement UPDATE) ────────────

/// `pending` → `expired`. Used by /api/aa/send when the loaded row's
/// `expires_at` is past; transitions the row so the partial unique index
/// releases the slot immediately rather than waiting for the cron sweep.
/// AlreadyClaimedError on rowCount === 0 — caller reloads + reroutes.
export async function transitionPendingToExpired(args: {
  rowId: string;
  sessionUserId: string;
}): Promise<'transitioned' | 'already_claimed'> {
  const result = await db
    .update(aaPendingUserOps)
    .set({ status: 'expired', statusUpdatedAt: new Date() })
    .where(
      and(
        eq(aaPendingUserOps.id, args.rowId),
        eq(aaPendingUserOps.userId, args.sessionUserId),
        eq(aaPendingUserOps.status, 'pending'),
      ),
    )
    .returning({ id: aaPendingUserOps.id });
  return result.length === 1 ? 'transitioned' : 'already_claimed';
}

/// `pending` → `sending`. Sets `user_op_hash` + `sending_started_at` to
/// satisfy `aa_pending_sending_requires_metadata`. Returns `'transitioned'`
/// on success, `'already_claimed'` on rowCount === 0 (another /api/aa/send
/// won the race; caller reloads + re-routes).
export async function transitionToSending(args: {
  rowId: string;
  sessionUserId: string;
  userOpHash: Hex;
}): Promise<'transitioned' | 'already_claimed'> {
  const result = await db
    .update(aaPendingUserOps)
    .set({
      status: 'sending',
      userOpHash: args.userOpHash.toLowerCase() as Hex,
      sendingStartedAt: new Date(),
      statusUpdatedAt: new Date(),
    })
    .where(
      and(
        eq(aaPendingUserOps.id, args.rowId),
        eq(aaPendingUserOps.userId, args.sessionUserId),
        eq(aaPendingUserOps.status, 'pending'),
      ),
    )
    .returning({ id: aaPendingUserOps.id });
  return result.length === 1 ? 'transitioned' : 'already_claimed';
}

/// `sending` → `sent`. Records the on-chain tx hash. Gated on prior
/// `sending` so we can't double-promote. AlreadyClaimedError on miss —
/// caller reloads (cron may have transitioned us first).
export async function transitionToSent(args: {
  rowId: string;
  txHash: Hex;
}): Promise<void> {
  const result = await db
    .update(aaPendingUserOps)
    .set({
      status: 'sent',
      txHash: args.txHash.toLowerCase() as Hex,
      statusUpdatedAt: new Date(),
    })
    .where(
      and(
        eq(aaPendingUserOps.id, args.rowId),
        eq(aaPendingUserOps.status, 'sending'),
      ),
    )
    .returning({ id: aaPendingUserOps.id });
  if (result.length === 0) throw new AlreadyClaimedError(args.rowId);
}

/// `sending` → `reverted`. tx_hash + failure_reason both required by
/// CHECK constraints.
export async function transitionToReverted(args: {
  rowId: string;
  txHash: Hex;
  failureReason: string;
}): Promise<void> {
  const result = await db
    .update(aaPendingUserOps)
    .set({
      status: 'reverted',
      txHash: args.txHash.toLowerCase() as Hex,
      failureReason: args.failureReason,
      statusUpdatedAt: new Date(),
    })
    .where(
      and(
        eq(aaPendingUserOps.id, args.rowId),
        eq(aaPendingUserOps.status, 'sending'),
      ),
    )
    .returning({ id: aaPendingUserOps.id });
  if (result.length === 0) throw new AlreadyClaimedError(args.rowId);
}

/// `sending` → `failed_pre_submit`. Bundler rejected before nonce advance.
/// failure_reason required by CHECK constraint.
export async function transitionToFailedPreSubmit(args: {
  rowId: string;
  failureReason: string;
}): Promise<void> {
  const result = await db
    .update(aaPendingUserOps)
    .set({
      status: 'failed_pre_submit',
      failureReason: args.failureReason,
      statusUpdatedAt: new Date(),
    })
    .where(
      and(
        eq(aaPendingUserOps.id, args.rowId),
        eq(aaPendingUserOps.status, 'sending'),
      ),
    )
    .returning({ id: aaPendingUserOps.id });
  if (result.length === 0) throw new AlreadyClaimedError(args.rowId);
}

/// `sending` → `submitted`. Bundler accepted but receipt poll didn't
/// confirm — cron resolver settles via on-chain truth later.
export async function transitionToSubmitted(args: {
  rowId: string;
  userOpHash: Hex;
}): Promise<void> {
  const result = await db
    .update(aaPendingUserOps)
    .set({
      status: 'submitted',
      userOpHash: args.userOpHash.toLowerCase() as Hex,
      statusUpdatedAt: new Date(),
    })
    .where(
      and(
        eq(aaPendingUserOps.id, args.rowId),
        eq(aaPendingUserOps.status, 'sending'),
      ),
    )
    .returning({ id: aaPendingUserOps.id });
  if (result.length === 0) throw new AlreadyClaimedError(args.rowId);
}

/// `submitted` → terminal via resolveSubmittedOp outcome. Used by both the
/// /api/aa/send re-call branch and the cron resolvers. Pass the outcome
/// shape from `resolveSubmittedOp` directly.
export type SubmittedResolution =
  | { kind: 'sent'; txHash: Hex }
  | { kind: 'reverted'; txHash: Hex; failureReason: string }
  | { kind: 'expired' }
  | { kind: 'ambiguous' };

/// Apply a resolveSubmittedOp result to a row currently in `submitted`.
/// `expired` is reachable when the bundler dropped the op (nonce never
/// advanced); for our schema we keep it under `expired` since the slot is
/// safe to release. `ambiguous` is the on-chain-nonce-mismatch case that
/// requires an operator.
export async function transitionFromSubmitted(args: {
  rowId: string;
  resolution: SubmittedResolution;
}): Promise<void> {
  switch (args.resolution.kind) {
    case 'sent': {
      const r = await db
        .update(aaPendingUserOps)
        .set({
          status: 'sent',
          txHash: args.resolution.txHash.toLowerCase() as Hex,
          statusUpdatedAt: new Date(),
        })
        .where(
          and(
            eq(aaPendingUserOps.id, args.rowId),
            eq(aaPendingUserOps.status, 'submitted'),
          ),
        )
        .returning({ id: aaPendingUserOps.id });
      if (r.length === 0) throw new AlreadyClaimedError(args.rowId);
      return;
    }
    case 'reverted': {
      const r = await db
        .update(aaPendingUserOps)
        .set({
          status: 'reverted',
          txHash: args.resolution.txHash.toLowerCase() as Hex,
          failureReason: args.resolution.failureReason,
          statusUpdatedAt: new Date(),
        })
        .where(
          and(
            eq(aaPendingUserOps.id, args.rowId),
            eq(aaPendingUserOps.status, 'submitted'),
          ),
        )
        .returning({ id: aaPendingUserOps.id });
      if (r.length === 0) throw new AlreadyClaimedError(args.rowId);
      return;
    }
    case 'expired': {
      const r = await db
        .update(aaPendingUserOps)
        .set({ status: 'expired', statusUpdatedAt: new Date() })
        .where(
          and(
            eq(aaPendingUserOps.id, args.rowId),
            eq(aaPendingUserOps.status, 'submitted'),
          ),
        )
        .returning({ id: aaPendingUserOps.id });
      if (r.length === 0) throw new AlreadyClaimedError(args.rowId);
      return;
    }
    case 'ambiguous': {
      const r = await db
        .update(aaPendingUserOps)
        .set({ status: 'ambiguous', statusUpdatedAt: new Date() })
        .where(
          and(
            eq(aaPendingUserOps.id, args.rowId),
            eq(aaPendingUserOps.status, 'submitted'),
          ),
        )
        .returning({ id: aaPendingUserOps.id });
      if (r.length === 0) throw new AlreadyClaimedError(args.rowId);
      return;
    }
  }
}

/// Same shape as `transitionFromSubmitted` but gated on `sending` — used by
/// the fast cron's stale-`sending` recovery path. Any of the four outcomes
/// is reachable: bundler accepted (sent/reverted), bundler dropped
/// (expired), or nonce-advanced-without-receipt (ambiguous).
export async function transitionFromSendingViaResolver(args: {
  rowId: string;
  resolution: SubmittedResolution;
}): Promise<void> {
  switch (args.resolution.kind) {
    case 'sent': {
      const r = await db
        .update(aaPendingUserOps)
        .set({
          status: 'sent',
          txHash: args.resolution.txHash.toLowerCase() as Hex,
          statusUpdatedAt: new Date(),
        })
        .where(
          and(
            eq(aaPendingUserOps.id, args.rowId),
            eq(aaPendingUserOps.status, 'sending'),
          ),
        )
        .returning({ id: aaPendingUserOps.id });
      if (r.length === 0) throw new AlreadyClaimedError(args.rowId);
      return;
    }
    case 'reverted': {
      const r = await db
        .update(aaPendingUserOps)
        .set({
          status: 'reverted',
          txHash: args.resolution.txHash.toLowerCase() as Hex,
          failureReason: args.resolution.failureReason,
          statusUpdatedAt: new Date(),
        })
        .where(
          and(
            eq(aaPendingUserOps.id, args.rowId),
            eq(aaPendingUserOps.status, 'sending'),
          ),
        )
        .returning({ id: aaPendingUserOps.id });
      if (r.length === 0) throw new AlreadyClaimedError(args.rowId);
      return;
    }
    case 'expired': {
      const r = await db
        .update(aaPendingUserOps)
        .set({ status: 'expired', statusUpdatedAt: new Date() })
        .where(
          and(
            eq(aaPendingUserOps.id, args.rowId),
            eq(aaPendingUserOps.status, 'sending'),
          ),
        )
        .returning({ id: aaPendingUserOps.id });
      if (r.length === 0) throw new AlreadyClaimedError(args.rowId);
      return;
    }
    case 'ambiguous': {
      const r = await db
        .update(aaPendingUserOps)
        .set({ status: 'ambiguous', statusUpdatedAt: new Date() })
        .where(
          and(
            eq(aaPendingUserOps.id, args.rowId),
            eq(aaPendingUserOps.status, 'sending'),
          ),
        )
        .returning({ id: aaPendingUserOps.id });
      if (r.length === 0) throw new AlreadyClaimedError(args.rowId);
      return;
    }
  }
}

/// Bulk-expire `pending` rows past their `expires_at`. Used by the fast
/// cron. Returns the number of rows transitioned.
export async function expirePastDueRows(): Promise<number> {
  const result = await db
    .update(aaPendingUserOps)
    .set({ status: 'expired', statusUpdatedAt: new Date() })
    .where(
      and(
        eq(aaPendingUserOps.status, 'pending'),
        sql`${aaPendingUserOps.expiresAt} < now()`,
      ),
    )
    .returning({ id: aaPendingUserOps.id });
  return result.length;
}

/// Select rows for cron sweep. Used by both crons; the WHERE clause +
/// LIMIT 50 keep each handler under Vercel's function budget.
export async function selectStaleSendingRows(args: {
  thresholdMs: number;
  limit: number;
}): Promise<Array<AaPendingUserOp>> {
  const cutoff = new Date(Date.now() - args.thresholdMs);
  return db
    .select()
    .from(aaPendingUserOps)
    .where(
      and(
        eq(aaPendingUserOps.status, 'sending'),
        sql`${aaPendingUserOps.sendingStartedAt} < ${cutoff}`,
      ),
    )
    .limit(args.limit);
}

export async function selectStaleSubmittedRows(args: {
  thresholdMs: number;
  limit: number;
}): Promise<Array<AaPendingUserOp>> {
  const cutoff = new Date(Date.now() - args.thresholdMs);
  return db
    .select()
    .from(aaPendingUserOps)
    .where(
      and(
        eq(aaPendingUserOps.status, 'submitted'),
        sql`${aaPendingUserOps.statusUpdatedAt} < ${cutoff}`,
      ),
    )
    .limit(args.limit);
}

// ── status-aware view used by tests + the route's status switch ─────────────

export type LoadedRow = AaPendingUserOp;

export type { AaPendingStatus };
