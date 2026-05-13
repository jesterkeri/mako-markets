import 'server-only';

// ----------------------------------------------------------------------------
// src/lib/private-markets/draft.ts
//
// Phase 2C-1: server-side draft allocator. Called by POST
// /api/pm/markets/draft after the client picks a 32-byte clientNonce
// and decides on a shape. Allocates a non-synthetic slug, inserts a
// `pending` pm_markets row, and returns the slug so the client can
// proceed to /api/aa/sponsor.
//
// Architecture notes (per Phase 2C-1 plan v6):
//   - clientNonce uniqueness is enforced by the partial unique index
//     pm_markets_client_nonce_pending_uniq on (client_nonce) WHERE
//     create_status='pending' (migration 0006_private_markets.sql:136-138).
//     The ON CONFLICT target MUST match that single-column form —
//     using a multi-column target would error out at runtime
//     ("no matching unique constraint").
//   - clientNonce is GLOBALLY unique among pending rows (not scoped
//     per (chain, contract)). The route still stores chain_id +
//     contract_address for logical scoping, but the constraint is on
//     clientNonce alone.
//   - Metadata fields (title, description, options, etc.) are NOT
//     populated at draft time. They land via 2B-2's MarketCreated
//     handler when the indexer hydrates from view calls. The pending
//     row is just a slug reservation + clientNonce + creator + shape.
//   - On duplicate (same nonce, both pending), this helper returns
//     { ok: false, error: { kind: 'duplicate' } }. The route surfaces
//     this as 409 with the SAME response body for same-user AND
//     cross-user collisions (no info leak — Codex r1 MIN-2).
// ----------------------------------------------------------------------------

import { sql } from 'drizzle-orm';

import type { DbOrTx } from '@/db/client';
import { allocateSlug } from './slug';
import { normalizeHex } from './normalize';

export type PmShape = 'friendly' | 'open_vote' | 'prize_pool';

export interface AllocatePmDraftArgs {
  tx: DbOrTx;
  sessionWallet: `0x${string}`;
  chainId: number;
  contractAddress: `0x${string}`;
  shape: PmShape;
  clientNonce: `0x${string}`;
}

export interface AllocatePmDraftResult {
  pendingDbId: string;
  slug: string;
  /// Echoed back so the client doesn't have to recompute / round-trip
  /// the value from request body to response body.
  clientNonce: `0x${string}`;
}

export type AllocatePmDraftError =
  | { kind: 'duplicate' }
  | { kind: 'slug_exhausted' }
  | { kind: 'pending_cap'; count: number };

/// Cap on simultaneously-`pending` pm_markets rows per
/// (chain, contract, creator). Mirrors the per-Safe ceiling on
/// aa_pending_user_ops in spirit: one Safe should not be able to
/// accumulate dozens of orphan draft rows by double-submitting and
/// abandoning before sponsor. Set high enough that a careful user
/// can't trip it (drafts are sub-second to allocate), low enough
/// that a runaway client can't flood the table before the sweep
/// catches up. The 11th simultaneously-pending row for one Safe
/// is rejected with 429 at the route.
export const PM_DRAFT_PENDING_CAP_PER_SAFE = 10;

export async function allocatePmDraft(
  args: AllocatePmDraftArgs & {
    /// Override for tests. Production callers should rely on the
    /// PM_DRAFT_PENDING_CAP_PER_SAFE default.
    maxPendingPerSafe?: number;
  },
): Promise<
  | { ok: true; value: AllocatePmDraftResult }
  | { ok: false; error: AllocatePmDraftError }
> {
  const contractLower = normalizeHex(args.contractAddress, 20);
  const sessionLower = normalizeHex(args.sessionWallet, 20);
  const clientNonceLower = normalizeHex(args.clientNonce, 32);
  const cap = args.maxPendingPerSafe ?? PM_DRAFT_PENDING_CAP_PER_SAFE;

  // Codex 2C-1 r4 MAJ-1: serialize the count+insert under a
  // transaction-scoped advisory lock keyed by
  // (chain, contract, creator). Without this, two concurrent
  // requests at count=cap-1 could both pass the SELECT and both
  // INSERT, ending up at cap+1. With the lock, the second waiter
  // blocks until the first commits, then reads the post-commit
  // count and rejects.
  //
  // Key derivation: a single text key per Safe is hashed with
  // hashtext (int4); PG implicitly widens to int8 for the single-
  // argument pg_advisory_xact_lock(bigint) signature. Collisions
  // across different Safes are acceptable — a hash collision means
  // two unrelated Safes serialize on a single lock, which costs
  // throughput (~µs) but never lets the cap break.
  //
  // The lock is automatically released at transaction commit /
  // rollback; no manual cleanup needed.
  const lockKey =
    `pm-draft:${args.chainId}:${contractLower}:${sessionLower}`;
  await args.tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);

  const countRows = await args.tx.execute(sql`
    SELECT COUNT(*)::int AS c
      FROM pm_markets
     WHERE chain_id = ${args.chainId}
       AND contract_address = ${contractLower}
       AND creator = ${sessionLower}
       AND create_status = 'pending'
  `);
  const rawCount =
    (countRows as unknown as { rows?: unknown[] }).rows ??
    (countRows as unknown as unknown[]);
  const countList = (Array.isArray(rawCount) ? rawCount : []) as Array<{
    c: number | string;
  }>;
  const pendingCount = countList.length > 0 ? Number(countList[0].c) : 0;
  if (pendingCount >= cap) {
    return {
      ok: false,
      error: { kind: 'pending_cap', count: pendingCount },
    };
  }

  let slug: string;
  try {
    slug = await allocateSlug(args.tx, { syntheticDxRow: false });
  } catch {
    return { ok: false, error: { kind: 'slug_exhausted' } };
  }

  // Raw SQL ON CONFLICT — Drizzle's onConflictDoNothing does not
  // currently accept a `where` predicate for partial unique indexes.
  // Using a `sql` template pins the predicate byte-for-byte to the
  // index definition.
  const inserted = await args.tx.execute(sql`
    INSERT INTO pm_markets (
      chain_id, contract_address, slug, client_nonce, creator, shape,
      create_status, pending_at, market_id,
      title, description, stream_url,
      visibility_view, visibility_participation,
      staking_opens_at, close_at,
      per_stake_min, per_stake_max, per_wallet_cumulative_max, fixed_stake,
      winners_count, current_state, total_stake, fee_taken, dust
    ) VALUES (
      ${args.chainId}, ${contractLower}, ${slug}, ${clientNonceLower},
      ${sessionLower}, ${args.shape}, 'pending', now(), NULL,
      '', '', '',
      0, 0,
      to_timestamp(0), to_timestamp(1),
      '0', '0', '0', '0',
      0, 'created', '0', '0', '0'
    )
    ON CONFLICT (client_nonce)
      WHERE create_status = 'pending'
      DO NOTHING
    RETURNING id
  `);

  // postgres-js returns row arrays directly; pglite wraps in
  // `{ rows }`. The earlier .rows-only form silently worked in pglite
  // tests but 500'd in production — same class of bug Codex 2C-1
  // step-9 r1 CRIT-1 flagged in sponsor-gate.ts. Pattern mirrors
  // cleanup.ts:92-95.
  const rawInserted =
    (inserted as unknown as { rows?: unknown[] }).rows ??
    (inserted as unknown as unknown[]);
  const rows = (Array.isArray(rawInserted) ? rawInserted : []) as Array<{
    id: string;
  }>;
  if (rows.length === 0) {
    return { ok: false, error: { kind: 'duplicate' } };
  }
  return {
    ok: true,
    value: {
      pendingDbId: rows[0].id,
      slug,
      clientNonce: clientNonceLower as `0x${string}`,
    },
  };
}
