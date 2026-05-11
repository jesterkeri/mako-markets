import 'server-only';

// ----------------------------------------------------------------------------
// src/lib/private-markets/sponsor-gate.ts
//
// Phase 2C-1: draft-row lookup + creator + shape assertion for the
// sponsor route's `pm_create_market` branch. Called AFTER the 3-stage
// validator surface in `aa-call-allowlist.ts` has accepted the call.
//
// The route extracts clientNonceLower + shapeFromCall from the
// ABI-decoded params and hands them here along with the session's
// safe address. This helper:
//
//   1. Opens a db.transaction.
//   2. SELECTs the matching pending pm_markets row by
//        (chain_id, contract_address, client_nonce, create_status='pending')
//      FOR UPDATE.
//   3. Returns structured failures:
//        - no row matched              → pm_draft_missing
//        - row.creator != session safe → pm_draft_wrong_creator
//        - row.shape != shapeFromCall  → pm_draft_shape_mismatch
//      or success with the pendingDbId.
//   4. COMMITs (releases the row lock) — the sponsor route's rate-limit
//      + buildSponsoredUserOp + INSERT pending happen OUTSIDE this lock.
//      Per the v6 plan, the sweep race window opens here and is
//      accepted; recovery happens via the indexer's dx-row path.
//
// Why split this out of the route:
//   - The FOR UPDATE SQL needs real Postgres semantics to test — pglite
//     gives those. A pglite-backed test of this helper is meaningfully
//     stronger than mocking `db.transaction` at the route boundary.
//   - The route test file mocks this helper so it doesn't have to know
//     about FOR UPDATE behaviour; the helper's own tests cover that.
// ----------------------------------------------------------------------------

import { sql } from 'drizzle-orm';
import type { Address, Hex } from 'viem';

import { db } from '@/db/client';
import { normalizeHex } from './normalize';

export type PmSponsorGateOk = { ok: true; pendingDbId: string };
export type PmSponsorGateReason =
  | 'pm_draft_missing'
  | 'pm_draft_wrong_creator'
  | 'pm_draft_shape_mismatch';
export type PmSponsorGateErr = { ok: false; reason: PmSponsorGateReason };

export type PmShapeDb = 'friendly' | 'open_vote' | 'prize_pool';

export interface AssertPmSponsorDraftArgs {
  chainId: number;
  contractAddress: Address;
  /// 32-byte clientNonce. Lowercased internally; case-insensitive on input.
  clientNonce: Hex;
  /// The session user's safe address from user_safes. Compared to
  /// pm_markets.creator (also lowercased) — these MUST match the
  /// address that signs the SafeOp on chain.
  sessionWallet: Address;
  /// Shape decoded from the call params. The DB stores
  /// 'friendly' | 'open_vote' | 'prize_pool'; the helper compares the
  /// pre-mapped string form so the route does the uint8→string
  /// translation up front (via mapShapeEnum).
  shapeFromCall: PmShapeDb;
}

export async function assertPmSponsorDraft(
  args: AssertPmSponsorDraftArgs,
): Promise<PmSponsorGateOk | PmSponsorGateErr> {
  const contractLower = normalizeHex(args.contractAddress, 20);
  const sessionLower = normalizeHex(args.sessionWallet, 20);
  const clientNonceLower = normalizeHex(args.clientNonce, 32);

  // Single short transaction: SELECT FOR UPDATE, assert, COMMIT.
  // The lock is held only across the SELECT — by design — so the
  // route can pay external Pimlico latency without holding a row lock.
  return await db.transaction(async (tx) => {
    const result = await tx.execute(sql`
      SELECT id, creator, shape::text AS shape
        FROM pm_markets
       WHERE chain_id = ${args.chainId}
         AND contract_address = ${contractLower}
         AND client_nonce = ${clientNonceLower}
         AND create_status = 'pending'
         FOR UPDATE
    `);

    // postgres-js returns row arrays directly; pglite wraps in
    // `{ rows }`. Same dual-shape extraction pattern used elsewhere
    // in pm_* modules (see cleanup.ts:92-95). The earlier .rows-only
    // form silently worked in pglite tests but 500'd in production
    // (Codex 2C-1 step-9 r1 CRIT-1).
    const raw =
      (result as unknown as { rows?: unknown[] }).rows ??
      (result as unknown as unknown[]);
    const rows = (Array.isArray(raw) ? raw : []) as Array<{
      id: string;
      creator: string;
      shape: string;
    }>;

    if (rows.length === 0) {
      return { ok: false, reason: 'pm_draft_missing' } as const;
    }
    const row = rows[0];

    if (row.creator.toLowerCase() !== sessionLower) {
      return { ok: false, reason: 'pm_draft_wrong_creator' } as const;
    }

    if (row.shape !== args.shapeFromCall) {
      return { ok: false, reason: 'pm_draft_shape_mismatch' } as const;
    }

    return { ok: true, pendingDbId: row.id } as const;
  });
}
