// ----------------------------------------------------------------------------
// #186 Leaderboard — on-chain actor → display identity resolver.
//
// THE sharp edge this module exists for: the two identity columns are
// stored in DIFFERENT casings.
//   - user_safes.safe_address is CHECKSUMMED (deriveSafeAddress returns
//     viem getAddress(), safe.ts:154; inserted as-is, auth/route.ts).
//     A Magic user's on-chain BetPlaced.user IS this safe address.
//   - users.wallet_address is LOWERCASE (user-upsert.ts:178 + DB CHECK).
// The ledger's actor column is lowercase. So BOTH branches lower()
// their DB side here — a naive equality join silently renders every
// Magic user anonymous on their own leaderboard.
//
// Precedence when one address matches multiple rows (plan, Codex r1
// MINOR-3 — deterministic, exactly one label per address):
//   1. a row bearing a display_name beats a bare row;
//   2. tie → safe-branch beats wallet-branch;
//   3. tie → lowest user id (uuid lexicographic — arbitrary but stable).
// A best-row with NULL display_name yields NO entry — the UI falls back
// to the truncated address. display_name is non-unique, so the UI
// appends a short address suffix when a rendered name repeats on the
// board (collision handling lives in the component, the address is the
// map key here).
//
// Privacy: this module NEVER selects email (or any column beyond
// display_name + the precedence inputs). The board is a public surface.
// ----------------------------------------------------------------------------

import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';

import type { DbOrTx } from '@/db/client';
import { users, userSafes } from '@/db/schema';

export interface ResolvedIdentity {
  displayName: string;
  /// Which join branch won — exposed for tests/debugging only.
  branch: 'safe' | 'wallet';
}

interface CandidateRow {
  addr: string;
  displayName: string | null;
  userId: string;
  branch: 'safe' | 'wallet';
}

/// Resolve display names for a set of on-chain actor addresses.
/// Input casing is irrelevant (normalized to lowercase); the returned
/// map is keyed by the LOWERCASE address. Addresses with no
/// display-name-bearing match are absent — callers fall back to the
/// truncated address.
export async function resolveLabels(
  db: DbOrTx,
  addresses: readonly string[],
  chainId: number,
): Promise<Map<string, ResolvedIdentity>> {
  const lowered = [...new Set(addresses.map((a) => a.toLowerCase()))];
  if (lowered.length === 0) return new Map();

  // Branch 1: Magic users via their Safe smart account. lower() BOTH
  // sides — safe_address is stored checksummed.
  const safeRows = await db
    .select({
      addr: sql<string>`lower(${userSafes.safeAddress})`,
      displayName: users.displayName,
      userId: users.id,
    })
    .from(userSafes)
    .innerJoin(users, eq(users.id, userSafes.userId))
    .where(
      and(
        eq(userSafes.chainId, chainId),
        inArray(sql`lower(${userSafes.safeAddress})`, lowered),
      ),
    );

  // Branch 2: external-wallet users. wallet_address is already stored
  // lowercase (user-upsert.ts:178 + CHECK), but lower() anyway — the
  // join must not trust a column convention it doesn't own.
  const walletRows = await db
    .select({
      addr: sql<string>`lower(${users.walletAddress})`,
      displayName: users.displayName,
      userId: users.id,
    })
    .from(users)
    .where(
      and(
        isNotNull(users.walletAddress),
        inArray(sql`lower(${users.walletAddress})`, lowered),
      ),
    );

  const candidates: CandidateRow[] = [
    ...safeRows.map((r) => ({ ...r, branch: 'safe' as const })),
    ...walletRows.map((r) => ({ ...r, branch: 'wallet' as const })),
  ];

  // Fold to exactly one winning row per address.
  const best = new Map<string, CandidateRow>();
  for (const c of candidates) {
    const prev = best.get(c.addr);
    if (!prev || beats(c, prev)) best.set(c.addr, c);
  }

  const out = new Map<string, ResolvedIdentity>();
  for (const [addr, c] of best) {
    if (c.displayName !== null && c.displayName !== '') {
      out.set(addr, { displayName: c.displayName, branch: c.branch });
    }
  }
  return out;
}

/// True when `a` outranks `b` under the documented precedence.
function beats(a: CandidateRow, b: CandidateRow): boolean {
  const aNamed = a.displayName !== null && a.displayName !== '';
  const bNamed = b.displayName !== null && b.displayName !== '';
  if (aNamed !== bNamed) return aNamed;
  if (a.branch !== b.branch) return a.branch === 'safe';
  return a.userId < b.userId;
}
