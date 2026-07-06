import 'server-only';

// ----------------------------------------------------------------------------
// src/lib/comments/market-target.ts
//
// Resolve a comment's market TARGET server-side. For main markets the server
// STAMPS chain + contract from env (the client only ever supplies the numeric
// marketId) so nobody can plant a comment on an arbitrary contract key. For PM
// markets it resolves the slug → confirmed row + comments_enabled.
//
// checkMainMarket is the on-chain getMarket read the POST handler runs AFTER
// the attempt throttle (so it can't be used to burn RPC). It returns a
// tri-state so an unreachable RPC surfaces as 503, not a misleading 404.
// ----------------------------------------------------------------------------

import { and, eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { pmMarkets } from '@/db/schema';
import { getAaPublicClient } from '@/lib/aa-public-client';
import { MONAD_TESTNET_ID } from '@/lib/chain';
import { MAKO_ADDRESS, makoAbi } from '@/lib/contract';
import type { CommentTarget } from './queries';

/// Contract key stored on comment rows + the event ledger — always lowercase.
const CONTRACT_LOWER = MAKO_ADDRESS.toLowerCase();

export type MainTarget = Extract<CommentTarget, { scope: 'main' }>;
export type PmTarget = Extract<CommentTarget, { scope: 'pm' }>;

/// Stamp the main target from env. `marketId` MUST already be a validated
/// canonical uint256 string (the caller checks). No I/O.
export function resolveMainTarget(marketId: string): MainTarget {
  return {
    scope: 'main',
    chainId: MONAD_TESTNET_ID,
    contractAddress: CONTRACT_LOWER,
    marketId,
  };
}

/// Tri-state result of the on-chain existence check:
///   - 'exists'       — getMarket returned a market with a non-empty question.
///   - 'absent'       — getMarket returned but the market has no question
///                      (nonexistent id) → the write should 404.
///   - 'unverifiable' — the RPC read THREW (provider down / rate-limited /
///                      capacity exceeded). We could NOT confirm existence, so
///                      the gate still fails CLOSED (no write), but the route
///                      surfaces a 503 "try again" instead of a misleading
///                      "market not found". Keeps the reviewed fail-closed
///                      control; only the reported cause becomes honest.
export type MainMarketCheck = 'exists' | 'absent' | 'unverifiable';

/// One getMarket read: a market exists iff its question is non-empty (same test
/// as market/[id]/page.tsx:fetchMarket). Never allows a write it couldn't
/// verify — an RPC error resolves to 'unverifiable', not 'exists'.
export async function checkMainMarket(marketId: string): Promise<MainMarketCheck> {
  try {
    const client = getAaPublicClient(MONAD_TESTNET_ID);
    const m = (await client.readContract({
      address: MAKO_ADDRESS,
      abi: makoAbi,
      functionName: 'getMarket',
      args: [BigInt(marketId)],
    })) as { question?: string } | null;
    return m && typeof m.question === 'string' && m.question.length > 0
      ? 'exists'
      : 'absent';
  } catch {
    return 'unverifiable';
  }
}

export interface PmTargetResult {
  target: PmTarget;
  commentsEnabled: boolean;
}

/// Resolve a PM slug to its target. Only a CONFIRMED row is a valid comment
/// target. Authorized by slug possession (the LinkOnly view model); returns the
/// comments_enabled flag so the POST handler can block writes while reads stay
/// open. null when no confirmed row matches.
export async function resolvePmTarget(slug: string): Promise<PmTargetResult | null> {
  const rows = await db
    .select({
      id: pmMarkets.id,
      commentsEnabled: pmMarkets.commentsEnabled,
    })
    .from(pmMarkets)
    .where(and(eq(pmMarkets.slug, slug), eq(pmMarkets.createStatus, 'confirmed')))
    .limit(1);
  if (rows.length === 0) return null;
  return {
    target: { scope: 'pm', pmMarketDbId: rows[0].id },
    commentsEnabled: rows[0].commentsEnabled,
  };
}
