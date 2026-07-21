import { type Address } from 'viem';
import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { users } from '@/db/schema';
import { emailChangeCooldownWhere } from './cooldown-where';
import { type MagicWireUser } from '@/lib/users-wire';

/// Email-change cooldown in milliseconds. Mako policy: at most one
/// change per 365 days per user. The recovery model is "secure your
/// email account with 2FA," NOT "rotate the email if compromised" —
/// frequent rotation invites session-compromise → email-rotation →
/// permanent-lockout patterns. The annual cap pushes posture onto
/// 2FA, which is the intended fix.
///
/// Tunable via this constant; mainnet rollout may revisit (e.g.,
/// per-tier cooldowns). Until then, hard-coded so the policy reads
/// in one place.
const EMAIL_CHANGE_COOLDOWN_MS = 365 * 24 * 60 * 60 * 1000;
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
// Bucket B in the wire-shape policy (see src/lib/users-wire.ts). The
// route returns exactly one identity field — the just-set email — as
// the source of truth before /api/user/me re-fetches. The response is
// typed `{ ok: true } & Pick<WireUser, 'email'>` to pin that subset
// against the canonical wire shape; future schema changes that strip
// `email` from WireUser would surface here at the type level.
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
  // Magic-only — wallet sessions have no email column to update.
  // Defence-in-depth: the UI never surfaces this affordance to wallet
  // users (IdentityBlock branches on authType), but the route enforces
  // independently so a hand-crafted POST from a wallet session can't
  // bypass the UI gate.
  if (session.authType !== 'magic') {
    return Response.json({ error: 'wallet_session' }, { status: 400 });
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

  // Cooldown check: at most one email change per 365 days. NULL on the
  // column means "never changed since signup" → no cooldown active.
  // Read-then-write is atomic-enough at this scale (1-per-year cap
  // makes the TOCTTOU window irrelevant). The same condition is
  // ALSO included in the WHERE clause below as defense-in-depth.
  const existing = await db
    .select({ lastEmailChangedAt: users.lastEmailChangedAt })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);
  const lastChange = existing[0]?.lastEmailChangedAt ?? null;
  if (lastChange) {
    const cooldownEndMs =
      lastChange.getTime() + EMAIL_CHANGE_COOLDOWN_MS;
    if (Date.now() < cooldownEndMs) {
      return Response.json(
        {
          error: 'cooldown_active',
          availableAt: new Date(cooldownEndMs).toISOString(),
        },
        { status: 429 },
      );
    }
  }

  // Atomic UPDATE with EOA pin AND cooldown in WHERE. RETURNING id
  // confirms the row matched. uniq violation surfaces as a Drizzle/
  // Postgres error which we map to 409 email_taken.
  const oneYearAgo = new Date(Date.now() - EMAIL_CHANGE_COOLDOWN_MS);
  try {
    const updated = await db
      .update(users)
      .set({ email: newEmail, lastEmailChangedAt: new Date() })
      .where(emailChangeCooldownWhere(session.userId, didEoa, oneYearAgo))
      .returning({ id: users.id });

    if (updated.length === 0) {
      // Row not matched. Three possibilities:
      //   - EOA pin failed (should be unreachable given equality check
      //     above, but guard anyway since checks straddle a network call)
      //   - Cooldown WHERE clause rejected (race window: a concurrent
      //     change request landed between the pre-read above and this
      //     write — the loser sees last_email_changed_at already
      //     updated within the cooldown)
      //   - Row id no longer exists (shouldn't happen mid-session)
      //
      // Sub-F MINOR 2: returning eoa_mismatch for the race-loser case
      // would surface scary wallet-mismatch copy at a user who's just
      // hit a cooldown collision. Re-read to disambiguate. EOA mismatch
      // gets the catastrophic message; cooldown loser gets the friendly
      // 429 cooldown response identical to the read-side gate above.
      const after = await db
        .select({
          magicEoa: users.magicEoa,
          lastEmailChangedAt: users.lastEmailChangedAt,
        })
        .from(users)
        .where(eq(users.id, session.userId))
        .limit(1);
      const row = after[0];
      // Magic-only route (guard at top); the CHECK constraint guarantees
      // magic rows have non-null magic_eoa even though the column type
      // is nullable for wallet rows.
      if (row && row.magicEoa && row.magicEoa.toLowerCase() !== didEoa.toLowerCase()) {
        return Response.json({ error: 'eoa_mismatch' }, { status: 409 });
      }
      if (row?.lastEmailChangedAt) {
        const cooldownEndMs =
          row.lastEmailChangedAt.getTime() + EMAIL_CHANGE_COOLDOWN_MS;
        if (Date.now() < cooldownEndMs) {
          return Response.json(
            {
              error: 'cooldown_active',
              availableAt: new Date(cooldownEndMs).toISOString(),
            },
            { status: 429 },
          );
        }
      }
      // Neither EOA nor cooldown matched — the row id is gone or some
      // other invariant broke. Generic conflict.
      return Response.json({ error: 'conflict' }, { status: 409 });
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

  // Magic-only route — `email` is a Magic-shape field, so we narrow
  // the Pick to MagicWireUser. (Pick<WireUser, 'email'> doesn't
  // typecheck because `email` isn't in the union's intersection.)
  const responseBody: { ok: true } & Pick<MagicWireUser, 'email'> = {
    ok: true,
    email: newEmail,
  };
  return Response.json(responseBody);
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
