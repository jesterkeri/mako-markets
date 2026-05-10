import 'server-only';

// ----------------------------------------------------------------------------
// src/lib/private-markets/slug.ts
//
// Slug allocator for pm_markets rows. Two flavours:
//   - Pending rows (set by 2C's POST /api/private-markets/create): bare
//     8-char base62 suffix, e.g. `8x3k9p2v`.
//   - Synthetic dx- rows (set by 2B-2's MarketCreated handler when the
//     event has no matching pending row): `dx-` prefix + 8-char suffix,
//     e.g. `dx-8x3k9p2v`. Total stored slug length 11 chars.
//
// Collision check: the partial unique index `pm_markets_slug_active_uniq`
// only constrains create_status IN ('pending','confirmed'). Failed/
// abandoned rows keep their slug as audit history but don't block reuse.
// allocateSlug() generates a candidate, checks if any active row
// already uses that slug, and retries on collision (max 8 retries —
// 218T base62 combinations, expected first-try success rate ≈ 1).
//
// 2B-2 uses ONLY the dx- variant (synthetic-row insert). The bare
// variant is exercised by 2C's create endpoint when it ships.
// ----------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DbOrTx } from '@/db/client';
import { pmMarkets } from '@/db/schema';

export const SLUG_LENGTH = 8 as const;
export const DX_PREFIX = 'dx-' as const;
const BASE62_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export interface SlugAllocationOptions {
  /// When true, prepends `dx-` and only generates the suffix randomly.
  /// Used by the indexer when MarketCreated fires with no matching
  /// pending row (direct-contract-write fallback).
  syntheticDxRow?: boolean;
  /// Max collision retries before giving up. Default 8; even at 1
  /// trillion existing slugs the expected first-try success rate is
  /// effectively 1, so 8 is purely defensive.
  maxRetries?: number;
}

/// Generate a random 8-char base62 string using crypto.randomBytes.
/// Uses rejection sampling to keep the distribution uniform — taking
/// `byte % 62` directly would bias toward the first 4 alphabet
/// positions (256 % 62 = 8 leftover, not a multiple).
function generateRandomSuffix(): string {
  const out: string[] = [];
  // Allocate plenty of bytes; rejection rate is ~3% so 16 bytes is
  // ~99.999% likely to yield 8 valid chars on the first pass.
  const bytes = randomBytes(SLUG_LENGTH * 2);
  for (let i = 0; out.length < SLUG_LENGTH && i < bytes.length; i++) {
    const b = bytes[i];
    // 256 = 4 * 62 + 8; reject the top 8 values to keep uniform.
    if (b >= 248) continue;
    out.push(BASE62_ALPHABET[b % 62]);
  }
  if (out.length < SLUG_LENGTH) {
    // Astronomically unlikely; recurse with fresh bytes.
    return generateRandomSuffix();
  }
  return out.join('');
}

/// Allocate a slug guaranteed not to collide with an active row at
/// allocation time. The partial unique index is the final guard
/// against TOCTOU races; this helper does the read-side dedupe so
/// callers don't churn through doomed INSERTs.
///
/// Synthetic-dx mode: `syntheticDxRow: true` produces e.g.
/// `dx-8x3k9p2v`. The 2B-2 indexer's MarketCreated handler is the
/// only caller exercising this branch in 2B-2.
export async function allocateSlug(
  txOrDb: DbOrTx,
  opts: SlugAllocationOptions = {},
): Promise<string> {
  const synthetic = opts.syntheticDxRow ?? false;
  const maxRetries = opts.maxRetries ?? 8;

  // Codex round-1 n1: maxRetries is the count of attempts, not an
  // off-by-one cap. `attempt < maxRetries` runs exactly maxRetries
  // times (default 8); the final-failure throw fires after.
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const candidate = synthetic
      ? `${DX_PREFIX}${generateRandomSuffix()}`
      : generateRandomSuffix();

    // Active-row collision check, scoped to the same set the partial
    // unique index covers.
    const existing = await txOrDb
      .select({ id: pmMarkets.id })
      .from(pmMarkets)
      .where(
        and(
          eq(pmMarkets.slug, candidate),
          inArray(pmMarkets.createStatus, ['pending', 'confirmed']),
        ),
      )
      .limit(1);

    if (existing.length === 0) {
      return candidate;
    }
  }

  throw new Error(
    `allocateSlug: failed to find a free slug after ${maxRetries} attempts ` +
      `(synthetic=${synthetic}). This should be statistically impossible ` +
      `at any realistic active-row count; investigate.`,
  );
}

// Re-export sql so vitest fixtures that need to spy on raw SQL have
// the same import surface as the module's call sites.
export { sql };
