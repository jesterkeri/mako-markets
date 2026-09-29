import 'server-only';

import { and, eq, inArray, or, sql } from 'drizzle-orm';

import { type DbOrTx } from '@/db/client';
import { users, type User } from '@/db/schema';
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
      | 'eoa_with_different_email',
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
  /// True when this sign-in moved an existing account from its old signer (a Magic-era EOA) to the Privy
  /// wallet: the caller must repoint the account's Safe and revoke its other sessions.
  moved: boolean;
}

/**
 * Find-or-create the email account for a Privy identity (Joshua, 2026-09-29: everyone moves to Privy).
 *
 *   - No account for this email or these wallets: create one, signed by the first Privy wallet.
 *   - The account's signer is one of this Privy user's wallets: reuse it unchanged. So a second Privy wallet
 *     for the same user never silently moves the account to a different Safe.
 *   - The account's signer is NOT one of them (a Magic-era account): move it, once, to the first Privy
 *     wallet. The Magic key keeps control of the old Safe; the account now owns a new one.
 *   - A wallet already belongs to a different email, or the email and a wallet point at two accounts:
 *     IdentityConflictError, never a guess.
 *
 * Email ownership is proven by Privy's email code, exactly as Magic's was, so the move grants nothing Magic
 * sign-in did not already grant.
 */
/// What to do with a Privy sign-in, given the rows that already match its email or wallets. Pure, so every
/// case is tested without a database.
export type EmbeddedDecision =
  | { action: 'create'; eoa: string }
  | { action: 'reuse'; row: User }
  | { action: 'move'; row: User; eoa: string }
  | { action: 'conflict'; reason: 'email_with_different_eoa' | 'eoa_with_different_email' };

export function decideEmbeddedUser(existing: User[], email: string, wallets: string[]): EmbeddedDecision {
  if (wallets.length === 0) throw new Error('decideEmbeddedUser: no wallets');
  const primary = wallets[0];
  if (existing.length === 0) return { action: 'create', eoa: primary };
  if (existing.length > 1) return { action: 'conflict', reason: 'email_with_different_eoa' };
  const row = existing[0];
  if (row.email !== email) return { action: 'conflict', reason: 'eoa_with_different_email' };
  if (row.magicEoa !== null && wallets.includes(row.magicEoa)) return { action: 'reuse', row };
  return { action: 'move', row, eoa: primary };
}

export async function upsertEmbeddedUser(tx: DbOrTx, rawEmail: string, rawWallets: string[]): Promise<EmbeddedUpsert> {
  const email = normalizeEmail(rawEmail);
  const wallets = rawWallets.map((w) => normalizeEoa(w));
  if (wallets.length === 0) throw new Error('upsertEmbeddedUser: no wallets');

  const existing = await tx
    .select()
    .from(users)
    .where(or(eq(users.email, email), inArray(users.magicEoa, wallets)))
    .limit(3);

  const d = decideEmbeddedUser(existing, email, wallets);
  switch (d.action) {
    case 'conflict':
      throw new IdentityConflictError(d.reason);
    case 'reuse':
      return { user: d.row, moved: false };
    case 'create': {
      const inserted = await tx
        .insert(users)
        .values({ email, magicEoa: d.eoa, authType: 'magic' })
        .onConflictDoNothing()
        .returning();
      if (inserted.length === 1) return { user: inserted[0], moved: false };
      // A concurrent sign-in created it first: refuse rather than guess; the retry resolves cleanly.
      throw new IdentityConflictError('email_with_different_eoa');
    }
    case 'move': {
      // Conditional on the signer we read, so two concurrent sign-ins cannot both move it.
      const signer = d.row.magicEoa;
      const updated = await tx
        .update(users)
        .set({ magicEoa: d.eoa })
        .where(
          signer === null
            ? and(eq(users.id, d.row.id), sql`${users.magicEoa} IS NULL`)
            : and(eq(users.id, d.row.id), eq(users.magicEoa, signer)),
        )
        .returning();
      if (updated.length !== 1) throw new IdentityConflictError('email_with_different_eoa');
      return { user: updated[0], moved: true };
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
