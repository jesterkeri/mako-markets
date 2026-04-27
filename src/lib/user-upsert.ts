import 'server-only';

import { eq, or } from 'drizzle-orm';

import { type DbOrTx } from '@/db/client';
import { users, type User } from '@/db/schema';
import { normalizeEmail } from './email';

// ----------------------------------------------------------------------------
// src/lib/user-upsert.ts
//
// Strict (email, EOA) upsert for the Magic auth flow.
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
export async function upsertUserStrict(
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
    .values({ email, magicEoa: eoa })
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
