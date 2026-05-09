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

import { and, eq, inArray } from 'drizzle-orm';

import { db } from '@/db/client';
import { pmMarkets, pmOptions } from '@/db/schema';

import { normalizeHex } from './normalize';

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
    .where(eq(pmOptions.marketDbId, market.id));

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
    .where(eq(pmOptions.marketDbId, market.id));

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
