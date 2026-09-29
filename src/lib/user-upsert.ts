import 'server-only';

import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';

import { type DbOrTx } from '@/db/client';
import { sessions, userSafes, users, type User } from '@/db/schema';
import { SAFE_TRACKED_CHAIN_IDS } from './chain';
import { deriveSafeAddress } from './safe';
import { normalizeEmail } from './email';

// ----------------------------------------------------------------------------
// src/lib/user-upsert.ts
//
// Two upsert helpers, mirroring the magic/wallet split that
// `users-wire.ts` enforces on the read side:
//
//   • `upsertMagicUser(tx, email, eoa)` — find-or-create for the Magic
//     auth flow. Strict identity invariance (see big comment below).
//   • `upsertWalletUser(walletAddress, { tx })` — find-or-create for the
//     wallet auth flow. Idempotent on `wallet_address`; defensive
//     lowercase + EVM-format assertion before the write.
//
// The DB CHECK constraints (auth_type / wallet_address_lower /
// wallet_address_format) are the ultimate backstop. These helpers are
// the application-side mirror so callers never construct raw INSERT
// statements against `users`.
//
// Magic helper — strict (email, EOA) upsert
// ------------------------------------------
//
// Both `email` and `magic_eoa` are uniquely indexed in the users table. A
// successful Magic login produces a (validated email, EOA) pair from
// `magic.users.getMetadataByToken`. The auth route hands that pair to this
// helper inside a transaction.
//
// The contract enforced here is identity *invariance*: once an email is
// associated with an EOA in the users table, it stays associated. If a future
// Magic call returns a different EOA for the same email — or the same EOA
// under a different email — that's a signal something is wrong (Magic app
// rotation, account takeover, misconfiguration), and we refuse the write
// rather than silently re-pointing the row.
//
// The four cases:
//   1. No row matches either email or EOA  → INSERT new row
//   2. Row matches BOTH email AND EOA      → reuse, no write
//   3. Row matches email but EOA differs   → throw IDENTITY_CONFLICT
//   4. Row matches EOA but email differs   → throw IDENTITY_CONFLICT
//
// Race-safety: two concurrent first-login requests for the same identity
// can both pass a SELECT-then-INSERT check — both transactions see no row,
// both insert, the second hits a unique-constraint violation. The flow
// here is insert-first with `onConflictDoNothing`, then re-select on skip:
//
//   INSERT ... ON CONFLICT DO NOTHING RETURNING *;
//   if returned a row → that's our row, done.
//   if returned 0 rows → SELECT to find the winning row, then validate.
//
// `onConflictDoNothing()` without a target catches violations on either
// unique index (email or magic_eoa). The follow-up SELECT distinguishes
// reuse-the-existing-row from IDENTITY_CONFLICT.
//
// Email is normalized via the shared `normalizeEmail` helper before any read
// or write. EOA is normalized to lowercase here — the DB column is plain
// text and we want equality lookups to be case-insensitive even though
// `viem.getAddress()` returns checksummed form upstream.
//
// Wallet helper — idempotent (wallet_address) upsert
// ---------------------------------------------------
//
// Wallet rows have no email/EOA fields — only `wallet_address`. The
// `users_wallet_address_uniq` partial unique index (WHERE
// wallet_address IS NOT NULL) guarantees one row per address. We use a
// raw INSERT with the same partial-where clause because Drizzle's
// `onConflict()` doesn't reliably emit WHERE on partial indexes (the
// plan called this out as a codex round-1 MAJOR risk).
//
// Defensive lowercase + format assert before the write — mirrors the
// DB CHECKs so callers don't have to remember. Mixed-case input
// canonicalizes to a single row.
// ----------------------------------------------------------------------------

export class IdentityConflictError extends Error {
  constructor(
    public readonly reason:
      | 'email_with_different_eoa'
      | 'eoa_with_different_email'
      /// The account already belongs to a different Privy user (Codex T2.2 r1: never move it again).
      | 'privy_identity_mismatch'
      /// The account's Privy user no longer lists the account's signer among its wallets: refused, not
      /// silently rotated to a new Safe.
      | 'wallet_set_changed',
  ) {
    super(`IDENTITY_CONFLICT: ${reason}`);
    this.name = 'IdentityConflictError';
  }
}

function normalizeEoa(eoa: string): string {
  return eoa.toLowerCase();
}

/**
 * Find-or-create a `users` row by (email, EOA). Pass the transaction client
 * so the upsert participates in the same atomic unit as downstream writes
 * (user_safes, sessions). Throws `IdentityConflictError` on any partial
 * mismatch — see file header for the four cases.
 *
 * Race-safe: handles the concurrent-first-login case where two transactions
 * both observe no existing row.
 *
 * Returns the canonical user row (whether newly inserted or pre-existing).
 */
export async function upsertMagicUser(
  tx: DbOrTx,
  rawEmail: string,
  rawEoa: string,
): Promise<User> {
  const email = normalizeEmail(rawEmail);
  const eoa = normalizeEoa(rawEoa);

  // Try insert first. If no conflicting row exists, this returns the new
  // row. If either unique index conflicts, the INSERT is silently skipped
  // and we fall through to the strict re-select.
  const inserted = await tx
    .insert(users)
    .values({ email, magicEoa: eoa, authType: 'magic' })
    .onConflictDoNothing()
    .returning();

  if (inserted.length === 1) {
    return inserted[0];
  }

  // Skipped by ON CONFLICT — re-fetch under both indexes to figure out which
  // row caused the conflict and whether it's a clean reuse or a true
  // identity mismatch.
  const existing = await tx
    .select()
    .from(users)
    .where(or(eq(users.email, email), eq(users.magicEoa, eoa)))
    .limit(2);

  if (existing.length === 0) {
    // Insert was skipped but no row matches. Either an EXTREMELY rare
    // committed-then-deleted race or a programmer error. Either way it's
    // not a clean identity match — refuse rather than guess.
    throw new IdentityConflictError('email_with_different_eoa');
  }

  if (existing.length > 1) {
    // Both unique indexes hit but on DIFFERENT rows: the (email, EOA) pair
    // straddles two existing identities. Emphatically a conflict.
    throw new IdentityConflictError('email_with_different_eoa');
  }

  const row = existing[0];
  if (row.email === email && row.magicEoa === eoa) {
    return row;
  }
  if (row.email === email) {
    throw new IdentityConflictError('email_with_different_eoa');
  }
  // row.magicEoa === eoa but email differs
  throw new IdentityConflictError('eoa_with_different_email');
}

/// The result of signing in with a Privy identity.
export interface EmbeddedUpsert {
  user: User;
  /// True when this sign-in bound the account to its Privy user and, for a Magic-era account, moved its signer
  /// to the Privy wallet. The move already repointed the Safe and revoked every session (applyEmbeddedMove).
  moved: boolean;
  /// Set instead of moving when the account has TOTP on: the Privy wallet it will move to once the second
  /// factor passes. Nothing about the account has changed; the caller issues a pending-move challenge.
  pendingMoveTo?: string;
}

/**
 * Bind an account to its Privy user and move its signer, in the caller's transaction. Allowed ONCE: only
 * while the account has no Privy user, and only from the signer read (so a concurrent move cannot also
 * succeed). Repoints the account's Safe on every tracked chain and, when the signer changes, revokes every
 * session. Returns null, having changed nothing, if either condition no longer holds.
 */
export async function applyEmbeddedMove(
  tx: DbOrTx,
  args: { userId: string; from: string | null; to: string; privyUserId: string },
): Promise<User | null> {
  const to = normalizeEoa(args.to);
  const updated = await tx
    .update(users)
    .set({ magicEoa: to, privyUserId: args.privyUserId })
    .where(
      and(
        eq(users.id, args.userId),
        isNull(users.privyUserId),
        args.from === null ? isNull(users.magicEoa) : eq(users.magicEoa, args.from),
      ),
    )
    .returning();
  if (updated.length !== 1) return null;
  if (args.from === to) return updated[0]; // bound to Privy, signer unchanged: nothing else moves
  const safeAddress = deriveSafeAddress(to as `0x${string}`);
  for (const chainId of SAFE_TRACKED_CHAIN_IDS) {
    await tx
      .insert(userSafes)
      .values({ userId: args.userId, chainId, safeAddress })
      .onConflictDoUpdate({ target: [userSafes.userId, userSafes.chainId], set: { safeAddress } });
  }
  await tx.delete(sessions).where(eq(sessions.userId, args.userId));
  return updated[0];
}

/// What to do with a Privy sign-in, given the rows that already match its email or wallets. Pure, so every
/// case is tested without a database.
export type EmbeddedDecision =
  | { action: 'create'; eoa: string }
  | { action: 'reuse'; row: User }
  | { action: 'move'; row: User; eoa: string }
  | {
      action: 'conflict';
      reason: 'email_with_different_eoa' | 'eoa_with_different_email' | 'privy_identity_mismatch' | 'wallet_set_changed';
    };

/**
 * The account's Privy user is recorded on its first Privy sign-in and never changes (Codex T2.2 r1):
 *
 *   - No account: create one, bound to this Privy user, signed by its first wallet.
 *   - Bound to this Privy user: reuse it if its signer is one of the user's wallets; if not, refuse
 *     (wallet_set_changed) rather than rotate it to a new Safe.
 *   - Bound to a different Privy user: refuse (privy_identity_mismatch), even with the same verified email.
 *   - Not bound yet (Magic-era): bind it and move it ONCE, to its signer if that is already one of the user's
 *     wallets, otherwise to the first wallet.
 *   - A wallet signs for a different email, or the email and a wallet point at two accounts: refuse.
 */
export function decideEmbeddedUser(existing: User[], email: string, wallets: string[], privyUserId: string): EmbeddedDecision {
  if (wallets.length === 0) throw new Error('decideEmbeddedUser: no wallets');
  const primary = wallets[0];
  if (existing.length === 0) return { action: 'create', eoa: primary };
  if (existing.length > 1) return { action: 'conflict', reason: 'email_with_different_eoa' };
  const row = existing[0];
  if (row.email !== email) return { action: 'conflict', reason: 'eoa_with_different_email' };
  const signerIsTheirs = row.magicEoa !== null && wallets.includes(row.magicEoa);
  // Any empty value (NULL from the database) means not bound yet.
  if (row.privyUserId) {
    if (row.privyUserId !== privyUserId) return { action: 'conflict', reason: 'privy_identity_mismatch' };
    return signerIsTheirs ? { action: 'reuse', row } : { action: 'conflict', reason: 'wallet_set_changed' };
  }
  return { action: 'move', row, eoa: signerIsTheirs ? (row.magicEoa as string) : primary };
}

export async function upsertEmbeddedUser(
  tx: DbOrTx,
  rawEmail: string,
  rawWallets: string[],
  privyUserId: string,
  opts: { deferMoveIfTotp?: boolean } = {},
): Promise<EmbeddedUpsert> {
  const email = normalizeEmail(rawEmail);
  const wallets = rawWallets.map((w) => normalizeEoa(w));
  if (wallets.length === 0) throw new Error('upsertEmbeddedUser: no wallets');
  if (!privyUserId) throw new Error('upsertEmbeddedUser: no Privy user id');

  const existing = await tx
    .select()
    .from(users)
    .where(or(eq(users.email, email), inArray(users.magicEoa, wallets), eq(users.privyUserId, privyUserId)))
    .limit(3);

  const d = decideEmbeddedUser(existing, email, wallets, privyUserId);
  switch (d.action) {
    case 'conflict':
      throw new IdentityConflictError(d.reason);
    case 'reuse':
      return { user: d.row, moved: false };
    case 'create': {
      const inserted = await tx
        .insert(users)
        .values({ email, magicEoa: d.eoa, privyUserId, authType: 'magic' })
        .onConflictDoNothing()
        .returning();
      if (inserted.length === 1) return { user: inserted[0], moved: false };
      // A concurrent sign-in created it first: refuse rather than guess; the retry resolves cleanly.
      throw new IdentityConflictError('email_with_different_eoa');
    }
    case 'move': {
      // A 2FA account moves only after its second factor: proving the email alone must not change the
      // account's signer, Safe or Privy identity, or sign its owner out (adversary pass, 2026-09-29).
      if (opts.deferMoveIfTotp && d.row.totpSecret) return { user: d.row, moved: false, pendingMoveTo: d.eoa };
      const moved = await applyEmbeddedMove(tx, { userId: d.row.id, from: d.row.magicEoa, to: d.eoa, privyUserId });
      if (!moved) throw new IdentityConflictError('email_with_different_eoa');
      return { user: moved, moved: true };
    }
  }
}

/**
 * Find-or-create a `users` row keyed on `wallet_address`. Idempotent —
 * repeat calls with the same address (any case) resolve to the same row.
 *
 * Lowercases + format-asserts the address before the write. The DB
 * CHECK constraints (`users_wallet_address_lower_chk`,
 * `users_wallet_address_format_chk`) reject malformed inputs at the
 * boundary regardless; this mirror lets callers see a clear error in
 * application code rather than a generic CHECK violation.
 *
 * Returns the narrower wire-relevant shape (id + editable identity
 * columns). Wallet rows don't have email/magic_eoa, so returning the
 * full `User` row would model them as nullable everywhere.
 */
export async function upsertWalletUser(
  raw: `0x${string}` | string,
  opts: { tx: DbOrTx },
): Promise<{ id: string; displayName: string | null; avatarUrl: string | null }> {
  const walletAddress = raw.toLowerCase() as `0x${string}`;
  if (!/^0x[0-9a-f]{40}$/.test(walletAddress)) {
    throw new Error(`upsertWalletUser: invalid address format: ${raw}`);
  }

  const w = opts.tx;

  // Raw ON CONFLICT against the partial unique index. Drizzle's
  // `onConflict()` does not reliably emit a `WHERE` clause for partial
  // unique indexes (codex round-1 MAJOR), so we hand-write the same
  // predicate the index uses.
  //
  // `tx.execute<T>(sql)` on the postgres-js driver returns a `RowList<T[]>`
  // — that's an array directly, NOT a `{ rows: [...] }` wrapper. The
  // adjacent `aa-sponsor-limits.incrementOrReject` uses the same access
  // pattern; treating this as `{ rows }` silently undefines `.length` and
  // produces `tx_failed` on every wallet sign-in (codex round-6 MAJOR).
  const inserted = await w.execute<{
    id: string;
    display_name: string | null;
    avatar_url: string | null;
  }>(sql`
    INSERT INTO users (wallet_address, auth_type)
    VALUES (${walletAddress}, 'wallet')
    ON CONFLICT (wallet_address) WHERE wallet_address IS NOT NULL
    DO NOTHING
    RETURNING id, display_name, avatar_url
  `);

  if (inserted.length > 0) {
    return {
      id: inserted[0].id,
      displayName: inserted[0].display_name,
      avatarUrl: inserted[0].avatar_url,
    };
  }

  // ON CONFLICT skipped → existing row. Re-select.
  const existing = await w
    .select({
      id: users.id,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
    })
    .from(users)
    .where(eq(users.walletAddress, walletAddress))
    .limit(1);

  if (existing.length === 0) {
    throw new Error('upsertWalletUser: row missing after ON CONFLICT DO NOTHING');
  }

  return existing[0];
}
