import 'server-only';

// ----------------------------------------------------------------------------
// src/lib/private-markets/cleanup.ts
//
// Phase 2B-5: stale-pending sweep. pm_markets rows in
// `create_status='pending'` whose `pending_at` is older than
// `ttlMs` get swept to `'failed'` with `failure_reason='stale-pending-sweep'`.
//
// Why this exists: the partial unique index
// `pm_markets_client_nonce_pending_uniq` only constrains pending rows,
// so a zombie pending row left behind by a failed AA flow blocks
// retries with the same clientNonce. Sweep frees the slot at TTL.
//
// Contract-scoped (Codex r1 m2): chainId + contractAddress are required
// args so multi-contract operation is an explicit caller-side loop.
// ----------------------------------------------------------------------------

import { sql } from 'drizzle-orm';

import type { DbOrTx } from '@/db/client';
import { pmMarkets } from '@/db/schema';

import { logMetric } from './alerting';
import { normalizeHex } from './normalize';

export interface SweepStalePendingArgs {
  chainId: number;
  contractAddress: `0x${string}`;
  /// Injectable for tests; defaults to `new Date()` in production.
  now: Date;
  /// Sweep rows whose `pending_at < (now - ttlMs)`.
  ttlMs: number;
  /// Per-tick batch limit. Postgres doesn't support raw `LIMIT` on
  /// UPDATE; the helper applies it via a subselect.
  limit: number;
}

export interface SweepStalePendingResult {
  swept: number;
}

export async function sweepStalePending(
  db: DbOrTx,
  args: SweepStalePendingArgs,
): Promise<SweepStalePendingResult> {
  const { chainId, contractAddress, now, ttlMs, limit } = args;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RangeError(
      `sweepStalePending: limit must be a positive integer; got ${limit}`,
    );
  }
  if (!Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new RangeError(
      `sweepStalePending: ttlMs must be a non-negative finite number; got ${ttlMs}`,
    );
  }

  // Codex 2B-5 r1 M3: normalise the contract address before the SQL
  // comparison. The indexer's processMarketCreated stores
  // contract_address lowercased (via normalizeHex), so a checksum-cased
  // env var here would silently match zero rows and leak stale rows
  // forever. Normalising at the helper boundary is symmetric with
  // every other write site.
  const contractAddressLower = normalizeHex(contractAddress, 20);

  const cutoff = new Date(now.getTime() - ttlMs);
  const cutoffIso = cutoff.toISOString();
  // postgres-js with `prepare: false` (Neon's pooled path) takes the
  // simple-query route and chokes on raw Date binds with
  // `TypeError: ERR_INVALID_ARG_TYPE` ("Received an instance of Date").
  // pglite is permissive and accepts Dates, which is why the
  // integration tests miss it; only the real DB surfaces this. Bind
  // the timestamp columns as ISO strings, matching `cutoffIso` above.
  const nowIso = now.toISOString();

  // Subselect → UPDATE. Each adapter (postgres-js + pglite) returns
  // rows on `.returning()` so the count is the actual UPDATE result,
  // not an estimate. Codex r1 m2: chain_id + contract_address are
  // baked into the WHERE so cleanup is contract-scoped.
  const result = await db.execute(sql`
    UPDATE pm_markets
       SET create_status = 'failed',
           failed_at = ${nowIso},
           failure_reason = 'stale-pending-sweep',
           updated_at = ${nowIso}
     WHERE id IN (
       SELECT id FROM pm_markets
        WHERE chain_id = ${chainId}
          AND contract_address = ${contractAddressLower}
          AND create_status = 'pending'
          AND pending_at < ${cutoffIso}
        ORDER BY pending_at ASC
        LIMIT ${limit}
     )
     RETURNING id
  `);

  // postgres-js returns row arrays directly; pglite wraps in `{ rows }`.
  const raw =
    (result as unknown as { rows?: unknown[] }).rows ??
    (result as unknown as unknown[]);
  const swept = Array.isArray(raw) ? raw.length : 0;

  if (swept > 0) {
    logMetric('stale-pending-swept', {
      component: 'pm-maintenance',
      handler: 'sweepStalePending',
      chainId,
      contractAddress: contractAddressLower,
      swept,
      ttlMs,
      limit,
    });
  }

  return { swept };
}
