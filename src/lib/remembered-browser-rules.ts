// ----------------------------------------------------------------------------
// src/lib/remembered-browser-rules.ts
//
// Remembered browsers (SIGNIN_REMEMBERED_BROWSER_PLAN r29, owner decisions Q-F to Q-I and Q-N): the pure rules. A
// browser that completed a full sign-in (a Privy email code Mako saw at the moment it was entered, then the
// authenticator) is remembered for 30 days; on it, signing in again needs only the authenticator. Everything here is a
// decision over values the caller read under its locks and its live database time `t`; the database work is in
// remembered-browser.ts.
// ----------------------------------------------------------------------------

import { createHash } from 'node:crypto';

/// The browser's binding secret: httpOnly, Secure, SameSite=Lax, path /api/user, 30 days. Only its hash is stored.
export const REMEMBERED_BROWSER_COOKIE = 'mako_rb';
export const REMEMBERED_BROWSER_COOKIE_PATH = '/api/user';
/// Owner decision Q-G: 30 days.
export const REMEMBERED_BROWSER_TTL_SEC = 30 * 24 * 60 * 60;

/// The email ceremony's secret: httpOnly, Secure, SameSite=Strict, path /api/user/auth, 90 minutes.
export const EMAIL_CEREMONY_COOKIE = 'mako_ec';
export const EMAIL_CEREMONY_COOKIE_PATH = '/api/user/auth';
export const EMAIL_CEREMONY_COOKIE_MAX_AGE_SEC = 90 * 60;

/// A ceremony must be verified (step A) within 30 minutes of email-start, then spent within 60 minutes of step A.
export const CEREMONY_VERIFY_WINDOW_MS = 30 * 60 * 1000;
export const CEREMONY_SPEND_WINDOW_MS = 60 * 60 * 1000;
/// Step A calls per ceremony (the CHECK on email_ceremonies.attempts).
export const STEP_A_MAX_ATTEMPTS = 10;
/// The token step A presents must be issued within 120 s after the email verification (both Privy's clock).
export const IAT_AFTER_VERIFICATION_MAX_SEC = 120;
/// And step A must arrive within 10 minutes of that token's issue, by the database clock (a coarse bound).
export const TOKEN_AGE_MAX_MS = 10 * 60 * 1000;
/// shortcut-check steers the client only while more than 10 minutes are left (r13).
export const SHORTCUT_CHECK_MARGIN_MS = 10 * 60 * 1000;
/// /api/user/auth issues a legacy challenge (5 minutes) only while the ceremony or row has more than 5 minutes left.
export const CHALLENGE_MARGIN_MS = 5 * 60 * 1000;

const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/// The Privy session id as stored: a hash, so the table never holds a usable identifier.
export function hashSid(sid: string): string {
  return createHash('sha256').update(`privy-sid:${sid}`).digest('hex');
}

/// A 32-byte base64url secret from this request's cookie header, or null (absent or malformed).
export function cookieSecret(req: Request, name: string): string | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1 || part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return SECRET_RE.test(value) ? value : null;
  }
  return null;
}

type LinkedAccount = { type: string; address?: string; latest_verified_at?: number | null };

/// The email linked account's `latest_verified_at` (seconds): the account whose address is the user's login email.
/// Null when it is missing, null, or not a positive whole number: step A then refuses (r12).
export function emailLatestVerifiedAt(read: { email: string | null; user: { linked_accounts: ReadonlyArray<LinkedAccount> } }): number | null {
  if (!read.email) return null;
  const acct = read.user.linked_accounts.find((a) => a.type === 'email' && typeof a.address === 'string' && a.address.trim().toLowerCase() === read.email);
  const v = acct?.latest_verified_at;
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null;
}

/// The Privy authenticator's fingerprint (plan 2.3): its `verified_at`, the only stable value Privy exposes for a TOTP
/// method (`@privy-io/node` users.d.ts: `type` and `verified_at`). Null without exactly one authenticator. S0 item 8
/// must show ordinary authenticator use does not re-stamp it before the feature is turned on.
export function factorFingerprint(user: { mfa_methods: ReadonlyArray<{ type: string; verified_at: number }> }): number | null {
  const totp = user.mfa_methods.filter((m) => m.type === 'totp');
  if (totp.length !== 1) return null;
  const at = totp[0].verified_at;
  return Number.isSafeInteger(at) && at > 0 ? at : null;
}

export type Ceremony = {
  id: string;
  secretHash: string;
  createdAt: Date;
  verifiedAt: Date | null;
  verifiedSidHash: string | null;
  verifiedPrivyUserId: string | null;
  verifiedValue: number | null;
  usedAt: Date | null;
  voidedAt: Date | null;
  attempts: number;
};

export type RememberedRow = {
  id: string;
  userId: string;
  privySidHash: string;
  deviceSecretHash: string;
  ceremonyId: string;
  factorFingerprint: number;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date;
  revokedAt: Date | null;
};

/// Why the email is needed again, for the dialog's one line (plan 2.2): too slow, another device used the code, or the
/// sign-in could not be confirmed.
export type EmailReason = 'too_late' | 'other_device' | 'not_confirmed';

/// A usable ceremony (r18, the one definition every acceptance point uses): this browser's ceremony secret, verified,
/// unspent, unvoided, within 60 minutes of its verification by the database clock `t`, verified for this Privy session
/// and this Privy user.
export function usableCeremony(
  c: Ceremony | null | undefined,
  args: { secretHash: string | null; sidHash: string | null; privyUserId: string; nowMs: number },
): boolean {
  return (
    !!c &&
    args.secretHash !== null &&
    args.sidHash !== null &&
    c.secretHash === args.secretHash &&
    c.verifiedAt !== null &&
    c.usedAt === null &&
    c.voidedAt === null &&
    args.nowMs - c.verifiedAt.getTime() <= CEREMONY_SPEND_WINDOW_MS &&
    c.verifiedSidHash === args.sidHash &&
    c.verifiedPrivyUserId === args.privyUserId
  );
}

/// What is left of a verified ceremony's 60 minutes at `nowMs`.
export function ceremonyMsLeft(c: Ceremony, nowMs: number): number {
  return c.verifiedAt ? c.verifiedAt.getTime() + CEREMONY_SPEND_WINDOW_MS - nowMs : -1;
}

/// Why a ceremony is not usable, for the dialog's message.
export function ceremonyReason(c: Ceremony | null | undefined, nowMs: number): EmailReason {
  if (c && c.verifiedAt && c.usedAt === null && c.voidedAt === null && ceremonyMsLeft(c, nowMs) < 0) return 'too_late';
  return 'not_confirmed';
}

export const rowActive = (r: RememberedRow, nowMs: number) => r.revokedAt === null && r.expiresAt.getTime() > nowMs;

/// Step A's decision (plan 2.2), on the locked ceremony and the database's `t`. `value` is the email account's
/// latest_verified_at, `seen` the account's recorded mark (null: none recorded or no account yet).
export type StepADecision =
  | { kind: 'verify' }
  /// A retry after a lost reply (r16): already verified for this session and user, unspent, unvoided, in its window.
  | { kind: 'already' }
  | { kind: 'refuse'; reason: EmailReason; countAttempt: boolean };

export function decideStepA(
  c: Ceremony | null,
  args: { secretHash: string; sidHash: string; privyUserId: string; iat: number; value: number | null; seen: number | null; nowMs: number },
): StepADecision {
  if (!c) return { kind: 'refuse', reason: 'not_confirmed', countAttempt: false };
  if (c.verifiedAt !== null) {
    if (usableCeremony(c, { secretHash: args.secretHash, sidHash: args.sidHash, privyUserId: args.privyUserId, nowMs: args.nowMs })) return { kind: 'already' };
    return { kind: 'refuse', reason: ceremonyReason(c, args.nowMs), countAttempt: false };
  }
  // Case (6): more than 10 step-A calls on one ceremony.
  if (c.attempts >= STEP_A_MAX_ATTEMPTS) return { kind: 'refuse', reason: 'not_confirmed', countAttempt: false };
  // Case (3): more than 30 minutes after email-start.
  if (args.nowMs - c.createdAt.getTime() > CEREMONY_VERIFY_WINDOW_MS) return { kind: 'refuse', reason: 'too_late', countAttempt: true };
  if (args.value === null) return { kind: 'refuse', reason: 'not_confirmed', countAttempt: true };
  // Case (1): the token was not issued within 120 s after this verification (Privy's clock on both sides). This, not
  // the token's origin, rules out an older session's token: a refreshed retained session has a fresh iat and an old
  // verification.
  const gap = args.iat - args.value;
  if (!(gap >= 0 && gap <= IAT_AFTER_VERIFICATION_MAX_SEC)) return { kind: 'refuse', reason: 'not_confirmed', countAttempt: true };
  // Case (2): step A more than 10 minutes after the token was issued, by the database clock.
  if (args.nowMs - args.iat * 1000 > TOKEN_AGE_MAX_MS) return { kind: 'refuse', reason: 'too_late', countAttempt: true };
  // A verification Mako already recorded (a sign-in elsewhere used this code).
  if (args.seen !== null && !(args.value > args.seen)) return { kind: 'refuse', reason: 'other_device', countAttempt: true };
  return { kind: 'verify' };
}

/// Step B's decision at /api/user/auth (plan 2.2 cases 1 to 3, the 2.3 triggers that apply there), on rows locked
/// before `t`. With the feature off: `off`, today's sign-in.
export type StepBDecision =
  | { kind: 'off' }
  /// Case 1: no row for this sid, a usable ceremony: bind (spend it, raise the mark from its value, insert the row).
  | { kind: 'bind'; ceremony: Ceremony }
  /// Case 2: an active row for this sid and this browser's mako_rb.
  | { kind: 'shortcut'; row: RememberedRow }
  /// Case 3's exception: a reply lost after the bind committed; a new mako_rb for the same row.
  | { kind: 'reissue'; row: RememberedRow }
  /// The authenticator changed (2.3): every row revoked and every pending ceremony voided, then the email again.
  | { kind: 'factor_changed' }
  /// A wrong or missing mako_rb on an active row: that row revoked (`device_mismatch`), then the email again.
  | { kind: 'device_mismatch'; row: RememberedRow }
  | { kind: 'email_required'; reason: EmailReason };

export function decideStepB(args: {
  enabled: boolean;
  sidHash: string | null;
  privyUserId: string;
  /// The row for (account, sid), if any, active or not.
  row: RememberedRow | null;
  /// The ceremony this browser's mako_ec names, locked; null without one.
  ceremony: Ceremony | null;
  ecHash: string | null;
  rbHash: string | null;
  fingerprint: number | null;
  nowMs: number;
}): StepBDecision {
  if (!args.enabled) return { kind: 'off' };
  if (args.sidHash === null) return { kind: 'email_required', reason: 'not_confirmed' };
  const { row, ceremony, nowMs } = args;
  if (!row) {
    if (usableCeremony(ceremony, { secretHash: args.ecHash, sidHash: args.sidHash, privyUserId: args.privyUserId, nowMs })) {
      return { kind: 'bind', ceremony: ceremony as Ceremony };
    }
    return { kind: 'email_required', reason: ceremonyReason(ceremony, nowMs) };
  }
  // A revoked or expired row keeps this sid needing the email for good (r12, r18: never re-issued).
  if (!rowActive(row, nowMs)) return { kind: 'email_required', reason: 'not_confirmed' };
  if (args.fingerprint === null || args.fingerprint !== row.factorFingerprint) return { kind: 'factor_changed' };
  if (args.rbHash !== null && args.rbHash === row.deviceSecretHash) return { kind: 'shortcut', row };
  if (reissuable(row, ceremony, args.ecHash, nowMs)) return { kind: 'reissue', row };
  return { kind: 'device_mismatch', row };
}

/// The lost-reply exception (case 3, adversary on r9): an active row never used, inside its ceremony's 60 minutes, and
/// the request carries that ceremony's (spent, unvoided) mako_ec.
export function reissuable(row: RememberedRow, ceremony: Ceremony | null, ecHash: string | null, nowMs: number): boolean {
  return (
    rowActive(row, nowMs) &&
    row.lastUsedAt === null &&
    !!ceremony &&
    ecHash !== null &&
    ceremony.id === row.ceremonyId &&
    ceremony.secretHash === ecHash &&
    ceremony.usedAt !== null &&
    ceremony.voidedAt === null &&
    ceremonyMsLeft(ceremony, nowMs) >= 0
  );
}

/// shortcut-check (read-only, before any authenticator prompt): the answer steers the client, and every later step
/// re-checks under its locks. `email_needed` is the one answer for "no row" and "bad cookie", so it reveals nothing.
export type ShortcutAnswer = 'shortcut' | 'bind_possible' | 'rebind' | 'email_needed';

export function decideShortcutCheck(args: {
  sidHash: string;
  privyUserId: string;
  row: RememberedRow | null;
  ceremony: Ceremony | null;
  ecHash: string | null;
  rbHash: string | null;
  fingerprint: number | null;
  nowMs: number;
}): ShortcutAnswer {
  const { row, ceremony, nowMs } = args;
  if (row) {
    if (!rowActive(row, nowMs) || args.fingerprint === null || args.fingerprint !== row.factorFingerprint) return 'email_needed';
    if (args.rbHash !== null && args.rbHash === row.deviceSecretHash) {
      return row.expiresAt.getTime() - nowMs > SHORTCUT_CHECK_MARGIN_MS ? 'shortcut' : 'email_needed';
    }
    return reissuable(row, ceremony, args.ecHash, nowMs) ? 'rebind' : 'email_needed';
  }
  if (
    usableCeremony(ceremony, { secretHash: args.ecHash, sidHash: args.sidHash, privyUserId: args.privyUserId, nowMs }) &&
    ceremonyMsLeft(ceremony as Ceremony, nowMs) > SHORTCUT_CHECK_MARGIN_MS
  ) {
    return 'bind_possible';
  }
  return 'email_needed';
}
