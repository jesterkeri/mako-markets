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
import { and, eq, gt, isNull } from 'drizzle-orm';
import { recoverMessageAddress, type Hex } from 'viem';

import type { DbOrTx } from '@/db/client';
import { privyProofNonces } from '@/db/schema';
import { parseProofMessage, PROOF_TTL_MS } from '@/lib/privy-proof-message';

/// A proof the browser may be up to this far ahead of the server's clock.
const CLOCK_SKEW_MS = 60_000;

export async function issueProofNonce(db: DbOrTx, privyUserId: string, wallet: string, nowMs: number): Promise<string> {
  const nonce = randomBytes(32).toString('base64url');
  await db.insert(privyProofNonces).values({
    nonce,
    privyUserId,
    wallet: wallet.toLowerCase(),
    expiresAt: new Date(nowMs + PROOF_TTL_MS),
  });
  return nonce;
}

export type ProofCheck = { ok: true } | { ok: false; reason: string };

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
  if (issued > args.nowMs + CLOCK_SKEW_MS || args.nowMs - issued > PROOF_TTL_MS) return { ok: false, reason: 'stale' };
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

/// Consumes the nonce once, only for the Privy user and wallet it was issued to, and only before it expires. Run it
/// inside the sign-in transaction, so a sign-in that fails later does not burn it silently and a replay finds it gone.
export async function consumeProofNonce(tx: DbOrTx, args: { nonce: string; privyUserId: string; wallet: string; nowMs: number }): Promise<boolean> {
  const rows = await tx
    .update(privyProofNonces)
    .set({ consumedAt: new Date(args.nowMs) })
    .where(
      and(
        eq(privyProofNonces.nonce, args.nonce),
        eq(privyProofNonces.privyUserId, args.privyUserId),
        eq(privyProofNonces.wallet, args.wallet.toLowerCase()),
        isNull(privyProofNonces.consumedAt),
        gt(privyProofNonces.expiresAt, new Date(args.nowMs)),
      ),
    )
    .returning({ nonce: privyProofNonces.nonce });
  return rows.length === 1;
}
