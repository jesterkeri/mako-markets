import 'server-only';
// ----------------------------------------------------------------------------
// src/lib/remembered-browser-store.ts
//
// The writes that make the email required again (SIGNIN_REMEMBERED_BROWSER_PLAN r29 2.3, 2.4): void ceremonies, expire
// challenges, revoke remembered rows. Each writes exactly the rows its caller already locked (account-locks.ts), by id,
// stamped with the caller's live database time `t`, so none of them can wait on another transaction.
// ----------------------------------------------------------------------------

import { and, eq, gt, inArray, isNull } from 'drizzle-orm';

import type { DbOrTx } from '@/db/client';
import { authChallenges, emailCeremonies, rememberedBrowsers } from '@/db/schema';

export type RevokeReason =
  | 'sign_out_everywhere'
  | 'forget_browser'
  | 'factor_changed'
  | 'account_move'
  | 'proof_failed'
  | 'device_mismatch'
  | 'totp_lockout'
  | 'email_changed';

/// Voids these ceremonies, if still unspent and unvoided. A voided ceremony is refused everywhere.
export async function voidCeremonies(tx: DbOrTx, ids: string[], nowMs: number): Promise<void> {
  if (ids.length === 0) return;
  await tx
    .update(emailCeremonies)
    .set({ voidedAt: new Date(nowMs) })
    .where(and(inArray(emailCeremonies.id, ids), isNull(emailCeremonies.usedAt), isNull(emailCeremonies.voidedAt)));
}

/// Expires these sign-in challenges, if still unconsumed and unexpired.
export async function expireChallenges(tx: DbOrTx, ids: string[], nowMs: number): Promise<void> {
  if (ids.length === 0) return;
  const t = new Date(nowMs);
  await tx
    .update(authChallenges)
    .set({ expiresAt: t })
    .where(and(inArray(authChallenges.id, ids), isNull(authChallenges.consumedAt), gt(authChallenges.expiresAt, t)));
}

/// Revokes these remembered rows, if not revoked already (the first reason is kept).
export async function revokeRememberedRows(tx: DbOrTx, ids: string[], reason: RevokeReason, nowMs: number): Promise<void> {
  if (ids.length === 0) return;
  await tx
    .update(rememberedBrowsers)
    .set({ revokedAt: new Date(nowMs), revokeReason: reason })
    .where(and(inArray(rememberedBrowsers.id, ids), isNull(rememberedBrowsers.revokedAt)));
}

/// The ids among `rows` a revoke would change: the ones not revoked yet.
export function activeIds(rows: ReadonlyArray<{ id: string; revokedAt: Date | null }>): string[] {
  return rows.filter((r) => r.revokedAt === null).map((r) => r.id);
}

/// The ids among `rows` a void would change: verified or not, still unspent and unvoided.
export function pendingCeremonyIds(rows: ReadonlyArray<{ id: string; usedAt: Date | null; voidedAt: Date | null }>): string[] {
  return rows.filter((r) => r.usedAt === null && r.voidedAt === null).map((r) => r.id);
}

/// The rows eq helper the routes use to find one remembered row of an account by its session id hash.
export const rememberedRowOf = (userId: string, sidHash: string) =>
  and(eq(rememberedBrowsers.userId, userId), eq(rememberedBrowsers.privySidHash, sidHash));
