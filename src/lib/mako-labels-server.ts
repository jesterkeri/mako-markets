import 'server-only';

// ----------------------------------------------------------------------------
// src/lib/mako-labels-server.ts
//
// Server-only DAO for MAKO outcome labels. `import 'server-only'` at the top
// makes Next throw if a client component pulls this in (the bundle would
// otherwise try to embed Drizzle + the connection string). Pair with
// `src/lib/use-mako-labels.ts` on the client side; both modules import the
// shared pure types from `src/lib/mako-labels.ts`.
//
// Key discipline (BINDING — see mako-labels.ts header):
//   Every public function in this module takes/returns `string` market IDs.
//   The single string→number conversion happens at the SQL boundary because
//   the underlying column is `bigint('market_id', { mode: 'number' })`
//   (matches the PM convention in pmMarkets / pmStakes). Internal-only.
//   Callers never see the number form.
//
// Why a single batched read path:
//   The home feed + admin markets list both render N MAKO markets at once.
//   Per-card queries would be N+1 against the DB. The route handler does
//   one `getMakoLabelsBatch` per request and the client passes labels down
//   via props (lifting batching to the feed parent — see plan round 6).
//   The single-market hook just calls the same batch endpoint with one id.
// ----------------------------------------------------------------------------

import { inArray } from 'drizzle-orm';
import { db as defaultDb, type DbOrTx } from '@/db/client';
import { makoMarketOutcomeLabels } from '@/db/schema';
import type { MakoLabelsMap, MakoOutcomeLabels } from '@/lib/mako-labels';

/// Internal — convert string ids to the number form Drizzle wants for the
/// `bigint mode:'number'` column. We accept strings publicly so the wire
/// shape and JS code can carry on-chain ids without lossy intermediaries,
/// then narrow once here at the boundary. Invalid strings (non-numeric or
/// negative) are filtered out rather than thrown — a bad id from the wire
/// shouldn't crash a multi-id request; the caller just gets no row for it.
///
/// IDs above `Number.MAX_SAFE_INTEGER` are also dropped because the column
/// is declared `bigint mode:'number'` (matching the PM convention in
/// `pmMarkets` / `pmStakes`) and `Number(id)` would silently lose precision
/// past 2^53. v4 testnet market IDs are tiny (~3 digits), so this is a
/// theoretical limit today; if MAKO market IDs ever approach that range,
/// switch the column to `bigint mode:'bigint'` AND change this conversion
/// path. The DAO's public signatures stay `string` either way.
function parseMarketIdsToNumbers(marketIds: string[]): number[] {
  const out: number[] = [];
  for (const id of marketIds) {
    if (!/^[0-9]+$/.test(id)) continue;
    const n = Number(id);
    if (!Number.isFinite(n) || n < 0) continue;
    if (n > Number.MAX_SAFE_INTEGER) continue;
    out.push(n);
  }
  return out;
}

/// Read labels for a single MAKO market. Returns `null` when no row exists
/// (caller falls back to YES/NO display per the round-3 helper rule).
export async function getMakoLabels(
  tx: DbOrTx,
  marketId: string,
): Promise<MakoOutcomeLabels | null> {
  const map = await getMakoLabelsBatch(tx, [marketId]);
  return map.get(marketId) ?? null;
}

/// Batched read for the home feed + admin markets list. Callers MUST pass
/// only MAKO market ids — non-MAKO ids are accepted (and simply yield no
/// rows) but populating the input with non-MAKO markets wastes a DB
/// round-trip's worth of bandwidth. The route handler enforces a cap of
/// 100 ids per request.
///
/// Returns a `Map<string, MakoOutcomeLabels>` (string keys per the discipline
/// rule). MAKO markets without a DB row are simply absent from the Map; the
/// caller's `.get(id) ?? null` fall-back is the documented contract.
export async function getMakoLabelsBatch(
  tx: DbOrTx,
  marketIds: string[],
): Promise<MakoLabelsMap> {
  if (marketIds.length === 0) return new Map();
  const ids = parseMarketIdsToNumbers(marketIds);
  if (ids.length === 0) return new Map();

  const rows = await tx
    .select({
      marketId: makoMarketOutcomeLabels.marketId,
      label1: makoMarketOutcomeLabels.label1,
      label2: makoMarketOutcomeLabels.label2,
    })
    .from(makoMarketOutcomeLabels)
    .where(inArray(makoMarketOutcomeLabels.marketId, ids));

  const map: MakoLabelsMap = new Map();
  for (const row of rows) {
    map.set(String(row.marketId), {
      label1: row.label1,
      label2: row.label2,
    });
  }
  return map;
}

/// Idempotent upsert. The admin write route calls this after `createMarket`
/// lands on chain and the `MarketCreated` event yields the marketId.
///
/// Idempotency matters because the admin edit surface
/// (`/admin/markets/[id]/labels`) hits the same DAO for both initial save
/// and later corrections; we never want two rows for one market.
export async function upsertMakoLabels(
  tx: DbOrTx,
  args: { marketId: string; label1: string; label2: string },
): Promise<MakoOutcomeLabels> {
  const ids = parseMarketIdsToNumbers([args.marketId]);
  if (ids.length === 0) {
    throw new Error(`upsertMakoLabels: invalid marketId ${args.marketId}`);
  }
  const numericId = ids[0];

  const [row] = await tx
    .insert(makoMarketOutcomeLabels)
    .values({
      marketId: numericId,
      label1: args.label1,
      label2: args.label2,
    })
    .onConflictDoUpdate({
      target: makoMarketOutcomeLabels.marketId,
      set: {
        label1: args.label1,
        label2: args.label2,
        updatedAt: new Date(),
      },
    })
    .returning({
      label1: makoMarketOutcomeLabels.label1,
      label2: makoMarketOutcomeLabels.label2,
    });

  return { label1: row.label1, label2: row.label2 };
}

/// Re-export for the rare server-side caller that wants to use the module's
/// default `db` rather than threading a tx — keeps the import surface flat.
export { defaultDb as db };
