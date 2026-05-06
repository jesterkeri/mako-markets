import { eq, lt, sql } from 'drizzle-orm';

import { db } from '@/db/client';
import { pendingTotpEnrollments, users } from '@/db/schema';
import { checkSameOrigin } from '@/lib/csrf';
import { encryptTotpSecret } from '@/lib/totp-crypto';
import { buildOtpAuthUri, generateTotpSecret } from '@/lib/totp';
import { getUserSession } from '@/lib/user-session';

// ----------------------------------------------------------------------------
// POST /api/user/totp/enroll
//
// Phase 1G — TOTP enrollment step 1. Server generates a fresh base32
// secret, encrypts under pending-slot AAD bound to (userId, slot=
// 'pending_totp_enrollments.encrypted_secret'), persists it, and returns:
//
//   { enrollmentId, otpauthUri }
//
// The otpauth URI carries the plaintext secret by construction — that's
// how authenticator apps ingest a new entry. The browser renders the QR
// from the URI client-side (qrcode.react). The client never echoes the
// secret back; /verify-enrollment takes { enrollmentId, code } only.
//
// Rejected when user.totp_secret IS NOT NULL (409 already_enabled). To
// re-enroll, the user must hit /api/user/totp/disable first.
//
// Stale pending rows are deleted opportunistically on each enroll call
// (`WHERE expires_at < now()` with NO user_id scope — every enroll
// reaps stranded rows from any user whose 10-min TTL has lapsed). Keeps
// the table small without a dedicated cron.
// ----------------------------------------------------------------------------

const PENDING_TTL_MIN = 10;
const PENDING_TTL_MS = PENDING_TTL_MIN * 60 * 1000;

export async function POST(req: Request) {
  const origin = checkSameOrigin(req);
  if (!origin.ok) {
    return Response.json({ error: 'cross_origin' }, { status: 403 });
  }

  const session = await getUserSession();
  if (!session) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  // Magic-only — wallet sessions never enroll TOTP. Defence-in-depth:
  // the UI's TOTP affordances are gated on authType, but the route
  // enforces independently.
  if (session.authType !== 'magic') {
    return Response.json({ error: 'wallet_session' }, { status: 400 });
  }

  // Already-enabled check happens here (cheap row read) so we don't waste
  // an INSERT + base32 generation on a state the route can't fulfil.
  // The verify-enrollment route ALSO gates on totp_secret IS NULL via a
  // conditional UPDATE so a concurrent enrollment can't overwrite an
  // already-enabled secret.
  const userRows = await db
    .select({ totpSecret: users.totpSecret, email: users.email })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);
  if (userRows.length === 0) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (userRows[0].totpSecret) {
    return Response.json({ error: 'already_enabled' }, { status: 409 });
  }
  // Magic-only route (guard above narrows session.authType). The CHECK
  // constraint guarantees magic rows have non-null email; the column
  // is `string | null` because wallet rows have no email. Assert to
  // narrow for the otpauthUri builder below.
  if (!userRows[0].email) {
    throw new Error('[totp/enroll] magic row missing email');
  }

  // Opportunistic cleanup of expired pending rows across ALL users.
  // The query isn't scoped to session.userId — every enroll call is
  // an opportunity to reap stranded rows whose 10-min TTL has lapsed,
  // which keeps the table small without a dedicated cron.
  await db
    .delete(pendingTotpEnrollments)
    .where(lt(pendingTotpEnrollments.expiresAt, sql`now()`));

  const secret = generateTotpSecret();
  const encryptedSecret = encryptTotpSecret({
    plain: secret,
    userId: session.userId,
    slot: 'pending_totp_enrollments.encrypted_secret',
  });
  const expiresAt = new Date(Date.now() + PENDING_TTL_MS);

  const inserted = await db
    .insert(pendingTotpEnrollments)
    .values({
      userId: session.userId,
      encryptedSecret,
      expiresAt,
    })
    .returning({ id: pendingTotpEnrollments.id });

  const otpauthUri = buildOtpAuthUri({
    secret,
    accountLabel: userRows[0].email,
  });

  return Response.json({
    ok: true,
    enrollmentId: inserted[0].id,
    otpauthUri,
  });
}
