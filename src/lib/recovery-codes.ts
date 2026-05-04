import 'server-only';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { recoveryCodes } from '@/db/schema';

// ----------------------------------------------------------------------------
// src/lib/recovery-codes.ts
//
// One-time backup codes for TOTP. 10 codes per user, generated when TOTP
// enables; consumed atomically inside the auth-totp route's transaction so
// the code only burns when the full sign-in commits.
//
// Format: `XXXX-XXXX-XX` (10 alphanumeric chars in three dash-joined
// groups). Character set excludes ambiguous shapes (`0OIl1o`) so a user
// reading codes off paper doesn't second-guess every other character.
//
// Hashing: bcryptjs cost 12 (~250ms per hash on Vercel's shared CPU). At
// 10 codes per generation that's ~2.5s sequential — `Promise.all` brings
// it to ~250ms since each hash is CPU-bound but Node interleaves the work.
// 40+ bits of entropy per code means brute-force is bounded by the
// per-user lockout counter, not the bcrypt cost.
//
// Transaction discipline: `verifyAndConsumeRecoveryCode` MUST plug into
// the caller's transaction. The auth-totp route opens one db.transaction
// that spans (a) recovery-code consume, (b) auth_challenges consume, (c)
// users state reset; ROLLBACK preserves the unused state. The helper
// signature takes `tx` explicitly to make this contract impossible to
// miss.
//
// The disable route can wrap this helper in its own single-step
// transaction when the user disables 2FA via a recovery code. Regenerate
// is TOTP-only and doesn't call this helper.
// ----------------------------------------------------------------------------

const BCRYPT_COST = 12;
const CODE_LENGTH = 10;
const DEFAULT_COUNT = 10;
// Alphabet: 2-9 + a-z minus the visually ambiguous set {0, o, i, l, 1}.
// 8 digits + 23 letters = 31 chars × 10 positions ≈ 49.5 bits of entropy.
// Plenty against online brute force given the per-user attempt counter
// caps at 5 before a 15-min lockout.
const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

export type VerifyAndConsumeResult =
  | { ok: false }
  | { ok: true; consumedId: string };

/// Generate `count` unique-within-batch recovery codes. Plaintext-level
/// dedup is checked here because bcrypt salts mean hash equality cannot
/// detect plaintext duplicates. Cross-user duplicates aren't a concern
/// (each user's hashes are independently salted).
export function generateRecoveryCodes(count: number = DEFAULT_COUNT): string[] {
  const out = new Set<string>();
  // ~49 bits of entropy per code — collision within a 10-element batch is
  // astronomically unlikely, but loop until we hit `count` unique values
  // anyway so the function is deterministic against the caller's contract.
  while (out.size < count) {
    out.add(formatCode(randomCharacters(CODE_LENGTH)));
  }
  return [...out];
}

function randomCharacters(length: number): string {
  // Reject-and-resample to keep the alphabet uniform. crypto.randomBytes
  // gives uniform bytes 0-255; we only accept bytes below
  // 256 - (256 % ALPHABET.length) and modulo into the alphabet.
  // For ALPHABET.length=31 the threshold is 256 - 8 = 248, so we
  // reject bytes 248-255 (~3% of samples).
  const out: string[] = [];
  while (out.length < length) {
    const bytes = randomBytes(length * 2); // overshoot to limit re-rolls
    for (const b of bytes) {
      if (b >= 256 - (256 % ALPHABET.length)) continue;
      out.push(ALPHABET[b % ALPHABET.length]);
      if (out.length === length) break;
    }
  }
  return out.join('');
}

/// Format a 10-char alphabet string as `XXXX-XXXX-XX`. The dashes are
/// purely cosmetic — readers + comparison strip them — but they make the
/// printed codes easier to read off paper.
function formatCode(raw: string): string {
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 10)}`;
}

/// Strip dashes + lowercase. Both ends of comparison run this so a user
/// who typed `ABCD efgh ij` with extra spaces / case still authenticates.
function normalizeCode(input: string): string {
  return input.replace(/[\s-]/g, '').toLowerCase();
}

/// Hash a recovery code with bcryptjs cost 12. Caller is responsible for
/// running these in `Promise.all` for the 10-code enrollment batch so the
/// total wall time stays at one-hash latency.
export async function hashRecoveryCode(code: string): Promise<string> {
  return bcrypt.hash(normalizeCode(code), BCRYPT_COST);
}

type Tx = Parameters<Parameters<typeof import('@/db/client').db['transaction']>[0]>[0];

/// Verify a submitted recovery code against the user's unused codes inside
/// the caller's transaction. Returns `{ ok: false }` for both "no match"
/// and "race lost on conditional UPDATE" — the caller cannot tell the two
/// apart and treats both as wrong-code.
///
/// The helper does NOT throw on `ok: false`. The caller throws a custom
/// error inside its `db.transaction` callback to trigger ROLLBACK; that's
/// what preserves the recovery-code's unused state when downstream steps
/// (challenge consume, user reset) fail.
///
/// SELECT FOR UPDATE intentionally holds the row lock through the bcrypt
/// loop so a concurrent consume cannot race-win the matched row. The
/// loop is ~250ms × N codes (sequential; ~2.5s for 10 codes worst case).
/// Acceptable cost for consume-once semantics at beta scale.
export async function verifyAndConsumeRecoveryCode(args: {
  tx: Tx;
  userId: string;
  code: string;
}): Promise<VerifyAndConsumeResult> {
  const { tx, userId, code } = args;
  const normalized = normalizeCode(code);

  const candidates = await tx
    .select({
      id: recoveryCodes.id,
      codeHash: recoveryCodes.codeHash,
    })
    .from(recoveryCodes)
    .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)))
    .for('update');

  let matchedId: string | null = null;
  for (const candidate of candidates) {
    // Sequential bcrypt-compare so each step runs in constant time relative
    // to the matched row. First match wins.
    if (await bcrypt.compare(normalized, candidate.codeHash)) {
      matchedId = candidate.id;
      break;
    }
  }
  if (!matchedId) return { ok: false };

  const consumed = await tx
    .update(recoveryCodes)
    .set({ usedAt: sql`now()` })
    .where(
      and(eq(recoveryCodes.id, matchedId), isNull(recoveryCodes.usedAt)),
    )
    .returning({ id: recoveryCodes.id });

  if (consumed.length === 0) {
    // Race-lost: another caller's transaction already consumed this row
    // between our SELECT FOR UPDATE and our UPDATE. Indistinguishable from
    // wrong-code at the route boundary.
    return { ok: false };
  }
  return { ok: true, consumedId: matchedId };
}
