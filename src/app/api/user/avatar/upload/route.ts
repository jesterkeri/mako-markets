import { randomUUID } from 'node:crypto';

import { type Address } from 'viem';
import { eq } from 'drizzle-orm';
import { put, del } from '@vercel/blob';
import sharp from 'sharp';

import { db } from '@/db/client';
import { users } from '@/db/schema';
import { avatarPathname, markForSweep } from '@/lib/avatar-sweep';
import { isOwnedAvatarBlobUrl } from '@/lib/avatar-url';
import { checkSameOrigin } from '@/lib/csrf';
import { readLastSignIn } from '@/lib/last-sign-in';
import { deriveSafeAddress } from '@/lib/safe';
import { getUserSession } from '@/lib/user-session';
import { magicUserToWire, walletUserToWire } from '@/lib/users-wire';

// ----------------------------------------------------------------------------
// POST /api/user/avatar/upload
//
// Multipart form upload. Field name `avatar` carries the image file.
// Returns the canonical bucket-A wire envelope (same shape as
// /api/user/profile/update) so the client can write the result straight
// into the ['user'] React Query cache.
//
// Pipeline:
//   1. Parse multipart, ensure single `avatar` field of type File
//   2. Reject if size > MAX_BYTES or content-type not in MIME_ALLOWLIST
//   3. Decode with sharp.metadata() — magic-byte sniff. Reject if format
//      mismatches the declared content type (anti–MIME-spoof).
//   4. Resize cover 256×256, output webp, strip EXIF (sharp default).
//   5. Replace the photo so a failure anywhere leaves at most files no account points at, which the avatar sweep
//      deletes within about 20 minutes, and the account always points at a stored photo (Joshua 2026-10-19, owner
//      decision Q-D, Codex PUBLIC_PROFILE R4 F1; src/lib/avatar-sweep.ts):
//      a. choose the new pathname, avatars/<userId>/<uuid>.webp, and record it in the sweep set BEFORE put(). If the
//         set cannot be written, nothing has happened: 503 sweep_unavailable.
//      b. put() it under exactly that name (addRandomSuffix false). Failure: 502 storage_unavailable, the account
//         unchanged (a file stored despite a lost answer is in the set).
//      c. one transaction, the row locked: read the current photo; if it is this user's own upload (the path-prefix
//         check is load-bearing, so a pasted foreign URL can never get another user's file deleted) record it in the
//         set too (failure: rolled back, 503); point the row at the new photo; commit.
//      d. record the replaced file again (best effort) and e. del() it (best effort). 200 once (c) committed.
//      The row only ever moves to a photo already stored, so the active photo is never broken.
//
// Vercel route body limit is 4.5 MB. We cap at 4 MB to leave headroom
// for multipart envelope overhead.
// ----------------------------------------------------------------------------

const EMAIL_CHANGE_COOLDOWN_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 4 * 1024 * 1024;
const MIME_ALLOWLIST = new Set(['image/png', 'image/jpeg', 'image/webp']);
const SHARP_FORMAT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
};

// The whole request is cut off well inside the sweep's 5-minute grace, so a new file is never swept before its row
// write could still commit.
export const maxDuration = 60;

/// Thrown inside the transaction when the replaced photo cannot be recorded for the sweep, so the transaction rolls back.
class SweepUnavailable extends Error {}

type UpdatedRow = Pick<
  typeof users.$inferSelect,
  'email' | 'magicEoa' | 'displayName' | 'avatarUrl' | 'totpSecret' | 'totpEnabledAt' | 'lastEmailChangedAt'
>;

export async function POST(req: Request) {
  const origin = checkSameOrigin(req);
  if (!origin.ok) {
    return Response.json({ error: 'cross_origin' }, { status: 403 });
  }

  const session = await getUserSession();
  if (!session) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return Response.json({ error: 'bad_body' }, { status: 400 });
  }

  const file = formData.get('avatar');
  if (!(file instanceof File)) {
    return Response.json({ error: 'bad_body' }, { status: 400 });
  }

  if (file.size === 0 || file.size > MAX_BYTES) {
    return Response.json({ error: 'bad_size' }, { status: 400 });
  }

  if (!MIME_ALLOWLIST.has(file.type)) {
    return Response.json({ error: 'bad_type' }, { status: 400 });
  }

  const inputBuffer = Buffer.from(await file.arrayBuffer());

  let resized: Buffer;
  try {
    const meta = await sharp(inputBuffer).metadata();
    if (!meta.format || meta.format !== SHARP_FORMAT_BY_MIME[file.type]) {
      return Response.json({ error: 'bad_image' }, { status: 400 });
    }
    resized = await sharp(inputBuffer)
      .rotate()
      .resize(256, 256, { fit: 'cover' })
      .webp({ quality: 85 })
      .toBuffer();
  } catch {
    return Response.json({ error: 'bad_image' }, { status: 400 });
  }

  // a. The new file is in the sweep set before it exists, so no failure from here on can leave it untracked.
  const pathname = `avatars/${session.userId}/${randomUUID()}.webp`;
  try {
    await markForSweep(pathname);
  } catch (e) {
    console.warn('[avatar-upload] sweep set unavailable, nothing changed', e instanceof Error ? e.name : 'error');
    return Response.json({ error: 'sweep_unavailable' }, { status: 503 });
  }

  // b. Stored under exactly the recorded name.
  let newUrl: string;
  try {
    const blob = await put(pathname, resized, { access: 'public', contentType: 'image/webp', addRandomSuffix: false });
    if (avatarPathname(blob.url) !== pathname) throw new Error('stored under an unexpected pathname');
    newUrl = blob.url;
  } catch (e) {
    console.error('[avatar-upload] blob put failed', e);
    return Response.json({ error: 'storage_unavailable' }, { status: 502 });
  }

  // c. The row is locked from the read of the current photo to the commit, so two requests from one account each
  // replace exactly the photo the other left (Codex PUBLIC_PROFILE R3 M1). A database failure here propagates: the new
  // file is in the set (swept unless the row turns out to point at it) and so is the replaced one.
  let result: { row: UpdatedRow; replaced: { url: string; pathname: string } | null } | undefined;
  try {
    result = await db.transaction(async (tx) => {
      const [current] = await tx.select({ url: users.avatarUrl }).from(users).where(eq(users.id, session.userId)).for('update');
      if (!current) return undefined;
      const oldPath = current.url && isOwnedAvatarBlobUrl(current.url, session.userId) ? avatarPathname(current.url) : null;
      if (oldPath) {
        try {
          await markForSweep(oldPath);
        } catch {
          throw new SweepUnavailable();
        }
      }
      const [updated] = await tx
        .update(users)
        .set({ avatarUrl: newUrl })
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
      return { row: updated, replaced: current.url && oldPath ? { url: current.url, pathname: oldPath } : null };
    });
  } catch (e) {
    if (e instanceof SweepUnavailable) return Response.json({ error: 'sweep_unavailable' }, { status: 503 });
    throw e;
  }

  if (result === undefined) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { row, replaced: old } = result;

  // d, e. Committed: the old file goes now if storage allows, else at the next sweep.
  if (old) {
    await markForSweep(old.pathname).catch((e) => console.warn('[avatar-upload] sweep re-mark failed', e instanceof Error ? e.name : 'error'));
    await del(old.url).catch((e) => console.warn('[avatar-upload] replaced blob delete failed, left to the sweep', e));
  }

  const lastSignInAt = await readLastSignIn(session.userId, session.sessionId);

  if (session.authType === 'magic') {
    const safeAddress = deriveSafeAddress(session.magicEoa as Address);

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
      ...magicUserToWire(row, safeAddress),
      lastSignInAt,
      nextEmailChangeAvailableAt,
    });
  }

  // session.authType === 'wallet'. The /avatars/<userId>/ blob path is
  // keyed off session.userId which exists in both shapes — no path
  // change. The wire helper drops the magic-only fields.
  return Response.json({
    ok: true,
    authed: true,
    ...walletUserToWire(row, session.walletAddress),
    lastSignInAt,
  });
}
