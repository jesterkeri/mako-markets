import 'server-only';
// ----------------------------------------------------------------------------
// src/lib/remembered-browser.ts
//
// Remembered browsers (SIGNIN_REMEMBERED_BROWSER_PLAN r29): the database side. The rules are in
// remembered-browser-rules.ts; the lock order in account-locks.ts; the void, expire and revoke writes in
// remembered-browser-store.ts. Every transaction here takes its locks first, in the account lock order, then reads one
// live database time `t` and writes only rows it holds.
//
// The feature is behind REMEMBERED_BROWSER_ENABLED (off = today's sign-in, an email code every time). Rollout (plan
// 2.2, r12): ship the client that handles `email_required` first, wait a day, then turn the flag on.
// ----------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';

import { db, type DbOrTx } from '@/db/client';
import { emailCeremonies, rememberedBrowsers, sessions, users } from '@/db/schema';
import { lockCeremonies, lockRememberedRows, lockSessions, lockUserRow } from '@/lib/account-locks';
import { databaseNowMs } from '@/lib/db-clock';
import { lockPrivyUser } from '@/lib/privy-admission';
import {
  decideStepA,
  EMAIL_CEREMONY_COOKIE,
  EMAIL_CEREMONY_COOKIE_MAX_AGE_SEC,
  EMAIL_CEREMONY_COOKIE_PATH,
  hashSecret,
  REMEMBERED_BROWSER_COOKIE,
  REMEMBERED_BROWSER_COOKIE_PATH,
  REMEMBERED_BROWSER_TTL_SEC,
  type Ceremony,
  type EmailReason,
  type RememberedRow,
} from '@/lib/remembered-browser-rules';
import { activeIds, pendingCeremonyIds, revokeRememberedRows, voidCeremonies, type RevokeReason } from '@/lib/remembered-browser-store';

export function rememberedBrowserEnabled(): boolean {
  const v = process.env.REMEMBERED_BROWSER_ENABLED?.trim().toLowerCase();
  return v === '1' || v === 'true';
}

export function newBrowserSecret(): string {
  return randomBytes(32).toString('base64url');
}

type CookieStore = { set: (name: string, value: string, opts: Record<string, unknown>) => unknown };

/// mako_rb: httpOnly, Secure, SameSite=Lax, path /api/user, 30 days (plan 2.1). An empty value clears it.
export function setBrowserCookie(store: CookieStore, secret: string | null): void {
  store.set(REMEMBERED_BROWSER_COOKIE, secret ?? '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: REMEMBERED_BROWSER_COOKIE_PATH,
    maxAge: secret ? REMEMBERED_BROWSER_TTL_SEC : 0,
  });
}

/// mako_ec: httpOnly, Secure, SameSite=Strict, path /api/user/auth, 90 minutes (plan 2.1).
export function setCeremonyCookie(store: CookieStore, secret: string): void {
  store.set(EMAIL_CEREMONY_COOKIE, secret, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: EMAIL_CEREMONY_COOKIE_PATH,
    maxAge: EMAIL_CEREMONY_COOKIE_MAX_AGE_SEC,
  });
}

/// email-start: a fresh ceremony naming no account. Its `created_at` is stamped by the database in this insert, which
/// waits on no lock. Returns the secret for the browser's cookie.
export async function issueCeremony(): Promise<string> {
  const secret = newBrowserSecret();
  await db.insert(emailCeremonies).values({ secretHash: hashSecret(secret) });
  return secret;
}

/// The id of the ceremony this secret hash names, read without a lock (the caller locks it by id at level (3)).
export async function ceremonyIdBySecret(secretHash: string | null): Promise<string | null> {
  if (!secretHash) return null;
  const rows = await db.select({ id: emailCeremonies.id }).from(emailCeremonies).where(eq(emailCeremonies.secretHash, secretHash)).limit(1);
  return rows[0]?.id ?? null;
}

/// The account this Privy sign-in is about: the one bound to the Privy user, else (Magic era, not bound yet) the one
/// with this email. Read without a lock.
export async function accountFor(
  privyUserId: string,
  email: string | null,
): Promise<{ id: string; seen: number | null; privyUserId: string | null; hasTotp: boolean; totpLockedUntil: Date | null } | null> {
  const cols = {
    id: users.id,
    seen: users.privyEmailVerifiedSeen,
    privyUserId: users.privyUserId,
    hasTotp: sql<boolean>`${users.totpSecret} IS NOT NULL`,
    totpLockedUntil: users.totpLockedUntil,
  };
  const bound = await db.select(cols).from(users).where(eq(users.privyUserId, privyUserId)).limit(1);
  if (bound[0]) return bound[0];
  if (!email) return null;
  const byEmail = await db.select(cols).from(users).where(and(eq(users.email, email), isNull(users.privyUserId))).limit(1);
  return byEmail[0] ?? null;
}

/// Step A (POST /api/user/auth/email-verified): records on the ceremony the verification seen right after
/// loginWithCode, or refuses. One short transaction holding only the ceremony row (a void or another step A on it can
/// hold that row); it reads `t` after that lock. Mints nothing and binds nothing.
export async function runStepA(args: {
  secretHash: string;
  sidHash: string;
  privyUserId: string;
  iat: number;
  value: number | null;
  seen: number | null;
}): Promise<{ ok: true } | { ok: false; reason: EmailReason }> {
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(emailCeremonies).where(eq(emailCeremonies.secretHash, args.secretHash)).for('update');
    const t = await databaseNowMs(tx);
    const d = decideStepA((rows[0] as Ceremony | undefined) ?? null, { ...args, nowMs: t });
    if (d.kind === 'already') return { ok: true } as const;
    if (d.kind === 'refuse') {
      if (d.countAttempt) await tx.update(emailCeremonies).set({ attempts: sql`${emailCeremonies.attempts} + 1` }).where(eq(emailCeremonies.id, rows[0].id));
      return { ok: false, reason: d.reason } as const;
    }
    await tx
      .update(emailCeremonies)
      .set({
        attempts: sql`${emailCeremonies.attempts} + 1`,
        verifiedAt: new Date(t),
        verifiedSidHash: args.sidHash,
        verifiedPrivyUserId: args.privyUserId,
        verifiedValue: args.value,
      })
      .where(and(eq(emailCeremonies.id, rows[0].id), isNull(emailCeremonies.verifiedAt)));
    return { ok: true } as const;
  });
}

/// The bind's claim on the verification (case 1): `seen = v` only while unrecorded or lower, exactly one row. Two
/// requests holding one verification bind at most once, and a value recorded meanwhile by any sign-in is refused.
export async function claimVerification(tx: DbOrTx, userId: string, v: number): Promise<boolean> {
  const rows = await tx
    .update(users)
    .set({ privyEmailVerifiedSeen: v })
    .where(and(eq(users.id, userId), or(isNull(users.privyEmailVerifiedSeen), sql`${users.privyEmailVerifiedSeen} < ${v}`)))
    .returning({ id: users.id });
  return rows.length === 1;
}

/// Every mint for an email account raises the mark, never lowers it.
export async function raiseSeen(tx: DbOrTx, userId: string, v: number | null): Promise<void> {
  if (v === null) return;
  await tx
    .update(users)
    .set({ privyEmailVerifiedSeen: sql`GREATEST(COALESCE(${users.privyEmailVerifiedSeen}, ${v}), ${v})` })
    .where(eq(users.id, userId));
}

/// Spends a usable ceremony: exactly one row, so a void that committed first always wins (r19).
export async function spendCeremony(tx: DbOrTx, id: string, nowMs: number): Promise<boolean> {
  const rows = await tx
    .update(emailCeremonies)
    .set({ usedAt: new Date(nowMs) })
    .where(and(eq(emailCeremonies.id, id), isNull(emailCeremonies.usedAt), isNull(emailCeremonies.voidedAt)))
    .returning({ id: emailCeremonies.id });
  return rows.length === 1;
}

/// The bind's row: created and expiring from `t`; last_used_at stays NULL ("never used" means exactly that).
export async function insertBinding(
  tx: DbOrTx,
  args: { userId: string; sidHash: string; deviceSecretHash: string; ceremonyId: string; fingerprint: number; nowMs: number },
): Promise<void> {
  await tx.insert(rememberedBrowsers).values({
    userId: args.userId,
    privySidHash: args.sidHash,
    deviceSecretHash: args.deviceSecretHash,
    ceremonyId: args.ceremonyId,
    factorFingerprint: args.fingerprint,
    createdAt: new Date(args.nowMs),
    expiresAt: new Date(args.nowMs + REMEMBERED_BROWSER_TTL_SEC * 1000),
  });
}

/// The shortcut's use of its (locked, active) row.
export async function markRowUsed(tx: DbOrTx, rowId: string, nowMs: number): Promise<boolean> {
  const rows = await tx
    .update(rememberedBrowsers)
    .set({ lastUsedAt: new Date(nowMs) })
    .where(and(eq(rememberedBrowsers.id, rowId), isNull(rememberedBrowsers.revokedAt), gt(rememberedBrowsers.expiresAt, new Date(nowMs))))
    .returning({ id: rememberedBrowsers.id });
  return rows.length === 1;
}

/// The lost-reply re-issue: a new mako_rb secret for the same (locked, active, never used) row.
export async function reissueRow(tx: DbOrTx, rowId: string, deviceSecretHash: string): Promise<void> {
  await tx.update(rememberedBrowsers).set({ deviceSecretHash }).where(and(eq(rememberedBrowsers.id, rowId), isNull(rememberedBrowsers.revokedAt)));
}

/// A trigger that makes the email required again, after the sign-in that found it rolled back (so the revoke is kept):
/// in its own transaction, in the lock order. `factor_changed` revokes every row of the account and voids every pending
/// ceremony of its Privy id (2.3); any other reason revokes the one row named.
export async function revokeAfterRefusal(args: { userId: string; privyUserId: string | null; reason: RevokeReason; rowId?: string }): Promise<void> {
  await db.transaction(async (tx) => {
    if (args.privyUserId) await lockPrivyUser(tx, args.privyUserId);
    if (args.reason === 'factor_changed') {
      await lockUserRow(tx, args.userId);
      const ceremonies = args.privyUserId ? await lockCeremonies(tx, { privyUserIds: [args.privyUserId] }) : [];
      const rows = await lockRememberedRows(tx, args.userId);
      const t = await databaseNowMs(tx);
      await voidCeremonies(tx, pendingCeremonyIds(ceremonies), t);
      await revokeRememberedRows(tx, activeIds(rows), args.reason, t);
      return;
    }
    const rows = (await lockRememberedRows(tx, args.userId)).filter((r) => r.id === args.rowId);
    const t = await databaseNowMs(tx);
    await revokeRememberedRows(tx, activeIds(rows), args.reason, t);
  });
}

/// "Sign out everywhere" (2.3): in one transaction holding the account's lock, every verified unspent ceremony of the
/// account voided FIRST, then every row revoked and every Mako session deleted; it also raises the mark to the email
/// account's current latest_verified_at, so no verification made before it can bind afterwards. A bind in progress
/// either commits before it (and is then revoked) or waits and finds its ceremony voided.
export async function signOutEverywhere(args: { userId: string; privyUserId: string | null; currentValue: number | null }): Promise<void> {
  await db.transaction(async (tx) => {
    if (args.privyUserId) await lockPrivyUser(tx, args.privyUserId); // (1)
    await lockUserRow(tx, args.userId); // (2)
    const ceremonies = args.privyUserId ? await lockCeremonies(tx, { privyUserIds: [args.privyUserId] }) : []; // (3)
    const rows = await lockRememberedRows(tx, args.userId); // (4)
    await lockSessions(tx, { userId: args.userId }); // (5)
    const t = await databaseNowMs(tx);
    await raiseSeen(tx, args.userId, args.currentValue);
    await voidCeremonies(tx, pendingCeremonyIds(ceremonies), t);
    await revokeRememberedRows(tx, activeIds(rows), 'sign_out_everywhere', t);
    await tx.delete(sessions).where(eq(sessions.userId, args.userId));
  });
}

/// "Sign out and forget this browser" (2.5) [r27]: (1) the account's lock, then this browser's row (4), then its own
/// session (5), in that order, so it can never deadlock with "Sign out everywhere".
export async function forgetBrowser(args: { userId: string; privyUserId: string | null; deviceSecretHash: string | null; sessionId: string }): Promise<void> {
  await db.transaction(async (tx) => {
    if (args.privyUserId) await lockPrivyUser(tx, args.privyUserId);
    const rows = args.deviceSecretHash ? (await lockRememberedRows(tx, args.userId)).filter((r) => r.deviceSecretHash === args.deviceSecretHash) : [];
    await lockSessions(tx, { sessionId: args.sessionId });
    const t = await databaseNowMs(tx);
    await revokeRememberedRows(tx, activeIds(rows), 'forget_browser', t);
    await tx.delete(sessions).where(eq(sessions.id, args.sessionId));
  });
}

/// Whether this browser holds an active binding of this account (sign-out's `bound` answer; no lock, decides nothing a
/// later step does not re-check).
export async function browserIsBound(userId: string, deviceSecretHash: string | null): Promise<boolean> {
  if (!deviceSecretHash) return false;
  const rows = await db
    .select({ id: rememberedBrowsers.id })
    .from(rememberedBrowsers)
    .where(
      and(
        eq(rememberedBrowsers.userId, userId),
        eq(rememberedBrowsers.deviceSecretHash, deviceSecretHash),
        isNull(rememberedBrowsers.revokedAt),
        gt(rememberedBrowsers.expiresAt, sql`clock_timestamp()`),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/// shortcut-check's read (no lock): the row for (account, sid) and the ceremony this browser names.
export async function readShortcutState(args: { userId: string | null; sidHash: string; ecHash: string | null }): Promise<{
  row: RememberedRow | null;
  ceremony: Ceremony | null;
  nowMs: number;
}> {
  const row = args.userId
    ? ((await db
        .select()
        .from(rememberedBrowsers)
        .where(and(eq(rememberedBrowsers.userId, args.userId), eq(rememberedBrowsers.privySidHash, args.sidHash)))
        .limit(1))[0] ?? null)
    : null;
  const ceremony = args.ecHash ? ((await db.select().from(emailCeremonies).where(eq(emailCeremonies.secretHash, args.ecHash)).limit(1))[0] ?? null) : null;
  return { row: row as RememberedRow | null, ceremony: ceremony as Ceremony | null, nowMs: await databaseNowMs(db) };
}
