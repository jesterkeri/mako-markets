import 'server-only';

// ----------------------------------------------------------------------------
// src/lib/private-markets/actor.ts  (#182 Slice B)
//
// Single source of truth for "which on-chain address identifies this
// session as a PM market's `creator`." The draft route STORES this value
// on the pending row; the sponsor/indexer COMPARE msg.sender / tx.origin
// against it; the comments-toggle route and /m/[slug] AUTHORIZE the
// creator against it. Those consumers MUST agree on the derivation, so it
// lives here rather than being re-inlined per route (the draft route's own
// comments flag this as a correctness requirement).
//
//   - Magic session → user_safes.safeAddress for (userId, chainId). The
//     Safe is msg.sender on chain; the EOA never touches the contract.
//   - Wallet session → session.walletAddress (the EOA is tx.origin).
//
// The address is returned verbatim from its source (Safe rows + wallet
// sessions are already lowercased on write, but callers still lower() both
// sides before comparing — defense in depth against any un-normalized row).
// ----------------------------------------------------------------------------

import { and, eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { userSafes } from '@/db/schema';
import type { UserSession } from '@/lib/user-session';

export type PmActorResult =
  | { ok: true; address: `0x${string}` }
  | { ok: false; error: 'no_user_safe' | 'no_creator' | 'unsupported_auth_type' };

export async function resolvePmActorAddress(
  session: UserSession,
  chainId: number,
): Promise<PmActorResult> {
  if (session.authType === 'magic') {
    const rows = await db
      .select({ safeAddress: userSafes.safeAddress })
      .from(userSafes)
      .where(
        and(eq(userSafes.userId, session.userId), eq(userSafes.chainId, chainId)),
      )
      .limit(1);
    const safe = rows[0];
    if (!safe) return { ok: false, error: 'no_user_safe' };
    return { ok: true, address: safe.safeAddress as `0x${string}` };
  }
  if (session.authType === 'wallet') {
    if (!session.walletAddress) return { ok: false, error: 'no_creator' };
    return { ok: true, address: session.walletAddress as `0x${string}` };
  }
  // Defensive: UserSession is a discriminated union and TS narrows this to
  // never. If a future auth_type lands without a branch, fail closed.
  return { ok: false, error: 'unsupported_auth_type' };
}
