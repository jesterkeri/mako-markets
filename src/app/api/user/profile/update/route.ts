import { type Address } from 'viem';
import { and, desc, eq, ne } from 'drizzle-orm';

import { db } from '@/db/client';
import { sessions, users } from '@/db/schema';
import { checkSameOrigin } from '@/lib/csrf';
import { deriveSafeAddress } from '@/lib/safe';
import { getUserSession } from '@/lib/user-session';
import { userToWire } from '@/lib/users-wire';

const EMAIL_CHANGE_COOLDOWN_MS = 365 * 24 * 60 * 60 * 1000;

// ----------------------------------------------------------------------------
// POST /api/user/profile/update
//
// Bucket A in the wire-shape policy (see src/lib/users-wire.ts).
//
// Body: { displayName?: string | null, avatarUrl?: string | null }
//
// At least one of the two keys must be present. Each is optional; the
// route updates only the columns the body explicitly touched. To clear
// a field, send `null`. Absence means "leave unchanged."
//
// displayName validation:
//   - string, trimmed, length 1-32
//   - regex /^[A-Za-z0-9 ._-]{1,32}$/ on the trimmed value
//   - the regex permits multiple internal spaces (intentional — display
//     names like "Joshua Z" or "Joshua  Z" are user choice). Trim
//     handles leading/trailing whitespace; internal whitespace is
//     preserved.
//
// avatarUrl validation:
//   - string, length ≤ 512
//   - parses via `new URL(value)` (parse failure → 400)
//   - https only (`parsed.protocol === 'https:'`)
//   - no userinfo (`parsed.username === '' && parsed.password === ''`)
//   - no fragments (`parsed.hash === ''`)
//   - stored as `parsed.toString()` (normalised). May differ from the
//     raw input by host casing, percent-encoding, or an added trailing
//     slash for origin-only URLs (e.g. https://example.com →
//     https://example.com/). Documented behaviour, not a bug.
//
// Response (success): the canonical bucket-A envelope identical to
// /api/user/me's authed branch and /api/user/auth's session-branch
// success — `{ ok, authed, ...WireUser, lastSignInAt,
// nextEmailChangeAvailableAt }`. The eager-cache caller (Group 4
// /profile UI) strips `ok` and writes the rest into the ['user']
// React Query cache.
// ----------------------------------------------------------------------------

const DISPLAY_NAME_RE = /^[A-Za-z0-9 ._-]{1,32}$/;
const AVATAR_URL_MAX_LEN = 512;

type UpdateInput = {
  displayName?: string | null;
  avatarUrl?: string | null;
};

type ValidatedFields = {
  displayName?: string | null;
  avatarUrl?: string | null;
};

function validateBody(raw: unknown): ValidatedFields | { error: string } {
  if (typeof raw !== 'object' || raw === null) {
    return { error: 'bad_body' };
  }
  const body = raw as Record<string, unknown>;
  const out: ValidatedFields = {};

  const hasDisplayName = Object.prototype.hasOwnProperty.call(body, 'displayName');
  const hasAvatarUrl = Object.prototype.hasOwnProperty.call(body, 'avatarUrl');
  if (!hasDisplayName && !hasAvatarUrl) {
    return { error: 'bad_body' };
  }

  if (hasDisplayName) {
    const v = body.displayName;
    if (v === null) {
      out.displayName = null;
    } else if (typeof v === 'string') {
      const trimmed = v.trim();
      if (trimmed.length === 0) return { error: 'bad_body' };
      if (!DISPLAY_NAME_RE.test(trimmed)) return { error: 'bad_body' };
      out.displayName = trimmed;
    } else {
      return { error: 'bad_body' };
    }
  }

  if (hasAvatarUrl) {
    const v = body.avatarUrl;
    if (v === null) {
      out.avatarUrl = null;
    } else if (typeof v === 'string') {
      if (v.length > AVATAR_URL_MAX_LEN) return { error: 'bad_body' };
      let parsed: URL;
      try {
        parsed = new URL(v);
      } catch {
        return { error: 'bad_body' };
      }
      if (parsed.protocol !== 'https:') return { error: 'bad_body' };
      if (parsed.username !== '' || parsed.password !== '') return { error: 'bad_body' };
      if (parsed.hash !== '') return { error: 'bad_body' };
      out.avatarUrl = parsed.toString();
    } else {
      return { error: 'bad_body' };
    }
  }

  return out;
}

export async function POST(req: Request) {
  const origin = checkSameOrigin(req);
  if (!origin.ok) {
    return Response.json({ error: 'cross_origin' }, { status: 403 });
  }

  const session = await getUserSession();
  if (!session) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  let raw: UpdateInput;
  try {
    raw = (await req.json()) as UpdateInput;
  } catch {
    return Response.json({ error: 'bad_body' }, { status: 400 });
  }

  const validated = validateBody(raw);
  if ('error' in validated) {
    return Response.json({ error: validated.error }, { status: 400 });
  }

  // Build the SET clause from the validated fields. Skipping a key
  // entirely (vs. setting to null) is what makes the update touch only
  // the columns the body asked for.
  const setClause: { displayName?: string | null; avatarUrl?: string | null } = {};
  if (Object.prototype.hasOwnProperty.call(validated, 'displayName')) {
    setClause.displayName = validated.displayName ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(validated, 'avatarUrl')) {
    setClause.avatarUrl = validated.avatarUrl ?? null;
  }

  const updated = await db
    .update(users)
    .set(setClause)
    .where(eq(users.id, session.userId))
    .returning({
      email: users.email,
      magicEoa: users.magicEoa,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      totpSecret: users.totpSecret,
      totpEnabledAt: users.totpEnabledAt,
      lastEmailChangedAt: users.lastEmailChangedAt,
    });

  if (updated.length === 0) {
    // Session points to a deleted user. Mirror /me semantics.
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  const row = updated[0];

  // Read the prior-session row (same shape /me uses) so the eager
  // cache write in the client doesn't lose lastSignInAt and force a
  // /me round-trip. Excludes the current session because this is an
  // authed write — the cookie's session is "now," not the prior
  // sign-in moment users care about.
  const priorSession = await db
    .select({ createdAt: sessions.createdAt })
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, session.userId),
        ne(sessions.id, session.sessionId),
      ),
    )
    .orderBy(desc(sessions.createdAt))
    .limit(1);

  const lastSignInAt =
    priorSession.length > 0 ? priorSession[0].createdAt.toISOString() : null;

  const safeAddress = deriveSafeAddress(row.magicEoa as Address);

  let nextEmailChangeAvailableAt: string | null = null;
  if (row.lastEmailChangedAt) {
    const cooldownEnd = row.lastEmailChangedAt.getTime() + EMAIL_CHANGE_COOLDOWN_MS;
    if (Date.now() < cooldownEnd) {
      nextEmailChangeAvailableAt = new Date(cooldownEnd).toISOString();
    }
  }

  return Response.json({
    ok: true,
    authed: true,
    ...userToWire(row, safeAddress),
    lastSignInAt,
    nextEmailChangeAvailableAt,
  });
}
