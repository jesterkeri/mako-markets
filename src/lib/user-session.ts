import 'server-only';

import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';

import { db, type DbOrTx } from '@/db/client';
import { sessions, users } from '@/db/schema';

// ----------------------------------------------------------------------------
// src/lib/user-session.ts
//
// End-user session cookies. Adapted from `admin-session.ts` with two changes:
//   1. Sessions are DB-backed via the `sessions` table — the cookie carries
//      an HMAC-signed session id, and every request checks the row still
//      exists. That lets us revoke individual sessions ("sign out everywhere")
//      by deleting rows.
//   2. The payload resolves to a full user record (id, email, magicEoa) via a
//      single join, so routes don't have to re-query the users table.
//
// Session lifetime: 7 days. Cookies are httpOnly, SameSite=Lax. The HMAC
// alone isn't proof of a live session — revocation requires the DB row too.
// ----------------------------------------------------------------------------

export const USER_SESSION_COOKIE = 'mako_user_session';
export const USER_SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 7;

type SessionCookiePayload = { sid: string; exp: number };

export type UserSession = {
  userId: string;
  email: string;
  magicEoa: string;
  sessionId: string;
};

function getSecret(): Buffer {
  const s = process.env.USER_SESSION_SECRET;
  if (!s || s.length < 32) {
    throw new Error(
      'USER_SESSION_SECRET missing or too short (need ≥32 chars). Generate with `openssl rand -hex 32` and set in .env.local and Vercel env.',
    );
  }
  return Buffer.from(s, 'utf8');
}

function b64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function sign(payloadJson: string): string {
  const body = b64url(Buffer.from(payloadJson, 'utf8'));
  const mac = b64url(createHmac('sha256', getSecret()).update(body).digest());
  return `${body}.${mac}`;
}

function verify<T extends { exp: number }>(token: string): T | null {
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = b64url(
    createHmac('sha256', getSecret()).update(body).digest(),
  );
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(b64urlDecode(body).toString('utf8')) as T;
    if (typeof parsed.exp !== 'number' || Date.now() / 1000 > parsed.exp) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function signSessionToken(sid: string): string {
  const payload: SessionCookiePayload = {
    sid,
    exp: Math.floor(Date.now() / 1000) + USER_SESSION_MAX_AGE_SEC,
  };
  return sign(JSON.stringify(payload));
}

export function verifySessionToken(
  token: string,
): SessionCookiePayload | null {
  return verify<SessionCookiePayload>(token);
}

// ---------------------------------------------------------------------------
// DB-backed operations
// ---------------------------------------------------------------------------

/**
 * Insert a new session row for `userId` and return the HMAC-signed cookie
 * value the caller should set on the response. Session id is pre-generated
 * so the INSERT lands complete (no mid-flight orphan rows if the process
 * dies between INSERT and UPDATE).
 *
 * Pass `opts.tx` when calling from inside a `db.transaction(...)` block so
 * the session insert participates in the same atomic unit as upstream user /
 * user_safes writes. Without it, the session row could be inserted while a
 * sibling write rolls back, leaving a session that points at a half-onboarded
 * user. Default behavior (no tx) is unchanged for any future standalone
 * caller.
 */
export async function createSession(
  userId: string,
  opts?: { tx?: DbOrTx },
): Promise<string> {
  const sid = randomUUID();
  const expiresAt = new Date(Date.now() + USER_SESSION_MAX_AGE_SEC * 1000);
  const token = signSessionToken(sid);

  const writer = opts?.tx ?? db;
  await writer.insert(sessions).values({
    id: sid,
    userId,
    expiresAt,
  });

  return token;
}

/**
 * Reads the session cookie from the current request, verifies the HMAC + TTL,
 * looks up the matching sessions row, and joins to users. Returns the user
 * payload on a live session, null on the common failure modes.
 *
 * Failure contract (what returns null vs throws):
 * - returns null:  missing cookie, bad MAC, cookie expired, session row
 *                  deleted, DB query rejected / timeout / connection drop.
 *                  DB errors are logged to stderr for observability.
 * - throws:        `USER_SESSION_SECRET` missing or <32 chars (deploy-config
 *                  error that must surface at first auth attempt), and
 *                  `cookies()` called outside a Next server route context
 *                  (programmer error, always fails on first render).
 *
 * In other words: transient/expected failures deauth, misconfiguration
 * crashes loudly. The two-clock DB-+-HMAC design means a blip on either side
 * is a soft deauth, not a 500.
 *
 * Call this at the top of every route that requires an authenticated user.
 */
export async function getUserSession(): Promise<UserSession | null> {
  const store = await cookies();
  const raw = store.get(USER_SESSION_COOKIE)?.value;
  if (!raw) return null;

  const payload = verifySessionToken(raw);
  if (!payload) return null;

  let rows: Array<{
    userId: string;
    email: string;
    magicEoa: string;
    sessionId: string;
    expiresAt: Date;
  }>;
  try {
    rows = await db
      .select({
        userId: users.id,
        email: users.email,
        magicEoa: users.magicEoa,
        sessionId: sessions.id,
        expiresAt: sessions.expiresAt,
      })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(eq(sessions.id, payload.sid))
      .limit(1);
  } catch (err) {
    // Observability over availability: log and return null. The caller sees
    // "not signed in", the user retries or re-auths, and the error shows up
    // in logs rather than a 500 response body.
    console.error('[user-session] DB lookup failed', err);
    return null;
  }

  if (rows.length === 0) return null;
  const row = rows[0];
  // Defence-in-depth: the HMAC already encoded an exp, but the DB row's
  // expiresAt is the authoritative clock (lets us shorten sessions server-side
  // without every cookie becoming instantly invalid).
  if (row.expiresAt.getTime() < Date.now()) return null;

  return {
    userId: row.userId,
    email: row.email,
    magicEoa: row.magicEoa,
    sessionId: row.sessionId,
  };
}

/**
 * Revoke a specific session by deleting its row. The HMAC cookie still
 * verifies cryptographically, but the DB lookup will miss and the session
 * will no longer resolve to a user. Idempotent.
 */
export async function revokeSession(sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

/**
 * Sign-out-everywhere: delete every session row for the user.
 */
export async function revokeAllSessionsForUser(userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}
