import 'server-only';
// ----------------------------------------------------------------------------
// src/lib/privy-proof.ts
//
// Server side of the sign-in proof (INBOX_GAP_PLAN r18, item 1): issue a single-use nonce bound to a Privy user and
// its wallet, and accept a sign-in only with a personal_sign by that wallet over the browser-built message that names
// this site and that nonce. Privy asks the enrolled authenticator before the wallet signs, so the signature proves the
// factor was passed in this sign-in, by whoever is signing in, not merely that a factor exists ([A1]).
// ----------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { recoverMessageAddress, type Hex } from 'viem';

import type { DbOrTx } from '@/db/client';
import { privyProofNonces } from '@/db/schema';
import { parseProofMessage, PROOF_TTL_MS } from '@/lib/privy-proof-message';

/// A proof the browser may be up to this far ahead of the server's clock.
const CLOCK_SKEW_MS = 60_000;

/// Issues a nonce whose expiry is stamped on the DATABASE's clock (clock_timestamp() in the insert itself, a single
/// statement that waits on no lock): the sign-in judges it on the database's live time `t`, so both sides of that
/// comparison are one clock (SIGNIN_REMEMBERED_BROWSER_PLAN r29 [r27]; this instance's Date.now() was used before).
export async function issueProofNonce(db: DbOrTx, privyUserId: string, wallet: string): Promise<string> {
  const nonce = randomBytes(32).toString('base64url');
  await db.insert(privyProofNonces).values({
    nonce,
    privyUserId,
    wallet: wallet.toLowerCase(),
    expiresAt: sql`clock_timestamp() + make_interval(secs => ${PROOF_TTL_MS / 1000})`,
  });
  return nonce;
}

/// `expired`: the message is older than its five minutes; `clock_skew`: it is dated more than a minute ahead of this
/// server (the device clock is wrong, never retried); the rest are a bad proof.
export type ProofCheck = { ok: true } | { ok: false; reason: 'bad_message' | 'wrong_site' | 'expired' | 'clock_skew' | 'bad_signature' | 'wrong_signer' };

/// Everything about the proof that needs no database: the exact message shape, this site, a fresh issue time, and a
/// signature recovering to the wallet the session will carry.
export async function checkProofSignature(args: {
  message: string;
  signature: string;
  wallet: string;
  site: string;
  nowMs: number;
}): Promise<ProofCheck & { nonce?: string }> {
  const parsed = parseProofMessage(args.message);
  if (!parsed) return { ok: false, reason: 'bad_message' };
  if (parsed.site !== args.site) return { ok: false, reason: 'wrong_site' };
  const issued = parsed.issued.getTime();
  if (issued > args.nowMs + CLOCK_SKEW_MS) return { ok: false, reason: 'clock_skew' };
  if (args.nowMs - issued > PROOF_TTL_MS) return { ok: false, reason: 'expired' };
  if (!/^0x[0-9a-fA-F]{130}$/.test(args.signature)) return { ok: false, reason: 'bad_signature' };
  let signer: string;
  try {
    signer = await recoverMessageAddress({ message: args.message, signature: args.signature as Hex });
  } catch {
    return { ok: false, reason: 'bad_signature' };
  }
  if (signer.toLowerCase() !== args.wallet.toLowerCase()) return { ok: false, reason: 'wrong_signer' };
  return { ok: true, nonce: parsed.nonce };
}

/// `ok`: consumed now. `expired`: issued to this Privy user and wallet, unused, but past its expiry at `nowMs`.
/// `reused`: already consumed. `unknown`: no such nonce for this Privy user and wallet.
export type NonceConsume = 'ok' | 'expired' | 'reused' | 'unknown';

/// Consumes the nonce once, only for the Privy user and wallet it was issued to, and only before it expires. Run it
/// inside the sign-in transaction, after its locks, with `nowMs` the transaction's live database time `t` [r27]: a nonce
/// that expired while the route waited on a lock is `expired`, never consumed, and a sign-in that fails later rolls the
/// consumption back. Its row cannot be held by another transaction then: any other consume of it holds the same
/// Privy user's lock.
export async function consumeProofNonce(tx: DbOrTx, args: { nonce: string; privyUserId: string; wallet: string; nowMs: number }): Promise<NonceConsume> {
  const mine = and(
    eq(privyProofNonces.nonce, args.nonce),
    eq(privyProofNonces.privyUserId, args.privyUserId),
    eq(privyProofNonces.wallet, args.wallet.toLowerCase()),
  );
  const rows = await tx
    .update(privyProofNonces)
    .set({ consumedAt: new Date(args.nowMs) })
    .where(and(mine, isNull(privyProofNonces.consumedAt), gt(privyProofNonces.expiresAt, new Date(args.nowMs))))
    .returning({ nonce: privyProofNonces.nonce });
  if (rows.length === 1) return 'ok';
  const found = await tx.select({ consumedAt: privyProofNonces.consumedAt }).from(privyProofNonces).where(mine).limit(1);
  if (found.length === 0) return 'unknown';
  return found[0].consumedAt !== null ? 'reused' : 'expired';
}
