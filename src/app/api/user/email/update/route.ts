import { type Address } from 'viem';
import { and, eq, sql } from 'drizzle-orm';

import { db } from '@/db/client';
import { users } from '@/db/schema';
import { isAllowedForCurrentStage } from '@/lib/allowlist';
import { checkSameOrigin } from '@/lib/csrf';
import { normalizeEmail } from '@/lib/email';
import {
  MagicConfigError,
  getMetadataByDidToken,
  validateDidToken,
} from '@/lib/magic-server';
import { getUserSession } from '@/lib/user-session';

// ----------------------------------------------------------------------------
// POST /api/user/email/update
//
// Body: { didToken: string }
//
// Phase 1E: lets a Magic-authed user change the email associated with their
// Magic account WITHOUT re-issuing Mako's session cookie. The Magic-derived
// EOA must remain stable across the email change (Path X invariant) — if
// it doesn't, this route refuses and surfaces a typed error so the
// frontend can warn the user before any DB write.
//
// Flow (mirrors the v3 design + Codex round-3 review):
//   0. Same-origin gate (CSRF parity with /api/user/auth)
//   1. getUserSession → 401 if absent
//   2. Body parse: { didToken: string }
//   3. validateDidToken (Magic admin SDK)
//   4. getMetadataByDidToken → { email, publicAddress }
//   5. CRITICAL: lower(publicAddress) === lower(session.magicEoa). Reject
//      with 409 eoa_mismatch otherwise — never silently rebind the Safe.
//   6. normalizeEmail on the new email (same path as /api/user/auth)
//   7. isAllowedForCurrentStage on the new email — beta allowlist gates
//      identity changes too, not just first signup
//   8. Atomic UPDATE: SET email = $1
//      WHERE id = session.userId AND lower(magic_eoa) = lower(meta.publicAddress)
//      RETURNING id. The EOA pin in the WHERE clause defends against a
//      race where another flow mutated the user's EOA between session
//      validation and this write.
//   9. uniq violation on users_email_uniq → 409 email_taken
//
// Mako's session cookie does NOT need to be re-issued: getUserSession
// joins sessions → users at every call and reads users.email live, so
// the cookie remains valid and /api/user/me will return the new email
// on the next read.
// ----------------------------------------------------------------------------

export async function POST(req: Request) {
  const origin = checkSameOrigin(req);
  if (!origin.ok) {
    return Response.json({ error: 'cross_origin' }, { status: 403 });
  }

  const session = await getUserSession();
  if (!session) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: { didToken?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'bad_body' }, { status: 400 });
  }
  if (typeof body.didToken !== 'string' || body.didToken.length === 0) {
    return Response.json({ error: 'bad_body' }, { status: 400 });
  }
  const didToken = body.didToken;

  try {
    await validateDidToken(didToken);
  } catch (err) {
    if (err instanceof MagicConfigError) {
      console.error(
        '[user/email/update] Magic admin config error',
        summarizeError(err),
      );
      return Response.json({ error: 'internal' }, { status: 500 });
    }
    console.warn(
      '[user/email/update] DID validation failed',
      summarizeError(err),
    );
    return Response.json({ error: 'bad_token' }, { status: 401 });
  }

  let newEmail: string;
  let didEoa: Address;
  try {
    const meta = await getMetadataByDidToken(didToken);
    newEmail = normalizeEmail(meta.email);
    didEoa = meta.publicAddress as Address;
  } catch (err) {
    if (err instanceof MagicConfigError) {
      console.error(
        '[user/email/update] Magic admin config error',
        summarizeError(err),
      );
      return Response.json({ error: 'internal' }, { status: 500 });
    }
    console.error(
      '[user/email/update] Magic metadata lookup failed',
      summarizeError(err),
    );
    return Response.json({ error: 'magic_metadata_failed' }, { status: 502 });
  }

  // CATASTROPHIC GUARD: if the DID's EOA differs from the session's EOA
  // we MUST refuse the update. A different EOA would mean the Magic
  // account behind the new email is a different wallet, not a renamed
  // identity — accepting the update would silently rebind the user's
  // Safe ownership to a stranger's key and destroy their funds binding.
  // No remediation; the only path is to tell the user something went
  // wrong and start over from /signup.
  if (didEoa.toLowerCase() !== session.magicEoa.toLowerCase()) {
    console.error('[user/email/update] EOA mismatch', {
      sessionEoa: session.magicEoa,
      didEoa,
    });
    return Response.json({ error: 'eoa_mismatch' }, { status: 409 });
  }

  // Allowlist re-check. Beta is email-gated; a tester switching to a
  // non-allowlisted email shouldn't get to keep their access.
  if (!(await isAllowedForCurrentStage(newEmail))) {
    return Response.json({ error: 'not_allowlisted' }, { status: 403 });
  }

  // Atomic UPDATE with EOA pin in WHERE. RETURNING id confirms the row
  // matched. uniq violation surfaces as a Drizzle/Postgres error which
  // we map to 409 email_taken.
  try {
    const updated = await db
      .update(users)
      .set({ email: newEmail })
      .where(
        and(
          eq(users.id, session.userId),
          sql`lower(${users.magicEoa}) = lower(${didEoa})`,
        ),
      )
      .returning({ id: users.id });

    if (updated.length === 0) {
      // Row not matched — the EOA pin failed defensively. Should be
      // unreachable given the EOA equality check above, but guard
      // anyway since the two checks straddle a network call.
      return Response.json({ error: 'eoa_mismatch' }, { status: 409 });
    }
  } catch (err) {
    if (isUniqueViolation(err, 'users_email_uniq')) {
      return Response.json({ error: 'email_taken' }, { status: 409 });
    }
    console.error(
      '[user/email/update] db update failed',
      summarizeError(err),
    );
    return Response.json({ error: 'internal' }, { status: 500 });
  }

  return Response.json({ ok: true, email: newEmail });
}

// ── error helpers ───────────────────────────────────────────────────────────

function summarizeError(err: unknown): {
  name: string;
  message: string;
} {
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  return { name: 'NonError', message: String(err) };
}

function isUniqueViolation(err: unknown, constraintName: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  // Postgres error code 23505 = unique_violation. Drizzle propagates the
  // `code` and `constraint` fields from `pg-native`/`postgres` driver.
  const e = err as { code?: string; constraint?: string };
  return e.code === '23505' && e.constraint === constraintName;
}
