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
// display_name, avatar_url + the precedence inputs). The board is a public surface, so a profile photo is returned
// only when THIS app uploaded it for that user (isAppOwnedAvatarUrl, strict: this app's own Blob store host and the
// user's own /avatars/<id>/ path), exactly as the public comments wire does; a legacy pasted URL is never served.
// ----------------------------------------------------------------------------

import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { getAddress, isAddress } from 'viem';

import type { DbOrTx } from '@/db/client';
import { users, userSafes } from '@/db/schema';
import { isAppOwnedAvatarUrl } from '@/lib/avatar-url';
import { publicAvatarPath } from '@/lib/public-avatar';

export interface ResolvedIdentity {
  /// The display name, or null when only a profile photo is set.
  displayName: string | null;
  /// The profile photo this app uploaded for the user (strictly checked), or null: from resolveLabels its public
  /// /api/avatar path, from resolveStoredIdentities the stored Blob URL.
  avatarUrl: string | null;
  /// Which join branch won — exposed for tests/debugging only.
  branch: 'safe' | 'wallet';
}

interface CandidateRow {
  addr: string;
  displayName: string | null;
  avatarUrl: string | null;
  userId: string;
  branch: 'safe' | 'wallet';
}

/// Resolve display names and profile photos for a set of on-chain actor addresses.
/// Input casing is irrelevant (normalized to lowercase); the returned
/// map is keyed by the LOWERCASE address. Addresses whose winning match has
/// neither a display name nor an app-owned photo are absent; callers fall
/// back to the truncated address and the letter avatar.
export async function resolveLabels(
  db: DbOrTx,
  addresses: readonly string[],
  chainId: number,
): Promise<Map<string, ResolvedIdentity>> {
  const stored = await resolveStoredIdentities(db, addresses, chainId);
  // The public never gets the stored photo URL (it carries the internal account id): only its /api/avatar path.
  for (const [addr, id] of stored) if (id.avatarUrl) stored.set(addr, { ...id, avatarUrl: publicAvatarPath(addr, id.avatarUrl) });
  return stored;
}

/// As resolveLabels, but with the STORED photo URL. Server-only: for /api/avatar, which streams it; never serialise it.
export async function resolveStoredIdentities(
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
      avatarUrl: users.avatarUrl,
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
      avatarUrl: users.avatarUrl,
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
    const displayName = c.displayName !== null && c.displayName !== '' ? c.displayName : null;
    const avatarUrl = c.avatarUrl && isAppOwnedAvatarUrl(c.avatarUrl, c.userId) ? c.avatarUrl : null;
    if (displayName !== null || avatarUrl !== null) {
      out.set(addr, { displayName, avatarUrl, branch: c.branch });
    }
  }
  return out;
}

/// The addresses (lowercase) that belong to a Mako Market account: a wallet sign-in, or an email account's Safe on
/// `chainId`. Only these have a public profile (Joshua 2026-10-17); a bettor who never signed in has none. Compares the
/// raw columns so both lookups use their indexes (Codex PUBLIC_PROFILE R1 M1): wallet_address is lowercase by CHECK,
/// and both Safe writers store deriveSafeAddress's checksummed form (the lowercase form is matched too, for safety).
export async function registeredAddresses(db: DbOrTx, addresses: readonly string[], chainId: number): Promise<Set<string>> {
  const lowered = [...new Set(addresses.map((a) => a.toLowerCase()))].filter((a) => isAddress(a, { strict: false }));
  if (lowered.length === 0) return new Set();
  const [wallets, safes] = await Promise.all([
    db.select({ addr: users.walletAddress }).from(users).where(inArray(users.walletAddress, lowered)),
    db
      .select({ addr: userSafes.safeAddress })
      .from(userSafes)
      .where(and(eq(userSafes.chainId, chainId), inArray(userSafes.safeAddress, [...lowered, ...lowered.map((a) => getAddress(a))]))),
  ]);
  return new Set([...wallets, ...safes].flatMap((r) => (r.addr ? [r.addr.toLowerCase()] : [])));
}

/// True when `a` outranks `b` under the documented precedence.
function beats(a: CandidateRow, b: CandidateRow): boolean {
  const aNamed = a.displayName !== null && a.displayName !== '';
  const bNamed = b.displayName !== null && b.displayName !== '';
  if (aNamed !== bNamed) return aNamed;
  if (a.branch !== b.branch) return a.branch === 'safe';
  return a.userId < b.userId;
}
