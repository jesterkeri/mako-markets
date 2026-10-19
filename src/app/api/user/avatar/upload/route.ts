import { type Address } from 'viem';
import { eq } from 'drizzle-orm';
import { put, del } from '@vercel/blob';
import sharp from 'sharp';

import { db } from '@/db/client';
import { users } from '@/db/schema';
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
//   5. In ONE transaction, with the account row locked (SELECT ... FOR
//      UPDATE) from the read of its current photo to the commit:
//      a. if the current photo is a Vercel Blob URL UNDER THIS USER'S
//         avatars/<userId>/ prefix, del() it first. The path-prefix
//         check is load-bearing: without it a caller could paste another
//         user's blob URL via /api/user/profile/update and then trigger
//         an upload to delete it. If the delete fails, the transaction
//         rolls back, nothing has changed: 503 photo_not_replaced.
//      b. put() the new file to avatars/<userId>/<unique>.webp, public.
//         If that fails after the old file was deleted, avatar_url is set
//         to NULL (the old file is gone) and committed: 502
//         storage_unavailable.
//      c. Update users.avatar_url to the new URL and commit.
//      A replaced photo is therefore deleted, never left public (Joshua
//      2026-10-17, Codex PUBLIC_PROFILE R3 M1, owner's fix 2026-10-19).
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

/// Thrown inside the transaction when the replaced photo cannot be deleted, so the transaction rolls back.
class PhotoNotReplaced extends Error {}

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

  // The row stays locked from the read of the current photo to the commit, so a second upload or a removal from the
  // same account waits here and then sees this one's result: each request deletes exactly the file it replaced and no
  // file is ever orphaned (Codex PUBLIC_PROFILE R3 M1).
  const uploaded: { url?: string } = {};
  let result: 'unauthorized' | 'storage_unavailable' | UpdatedRow | undefined;
  try {
    result = await db.transaction(async (tx) => {
      const [current] = await tx.select({ url: users.avatarUrl }).from(users).where(eq(users.id, session.userId)).for('update');
      if (!current) return 'unauthorized';

      // Delete first: a failure rolls the transaction back and nothing has changed.
      const replaced = current.url && isOwnedAvatarBlobUrl(current.url, session.userId) ? current.url : null;
      if (replaced) {
        try {
          await del(replaced);
        } catch (e) {
          console.warn('[avatar-upload] prior blob delete failed, nothing changed', e);
          throw new PhotoNotReplaced();
        }
      }

      try {
        const blob = await put(`avatars/${session.userId}/${Date.now()}.webp`, resized, {
          access: 'public',
          contentType: 'image/webp',
          addRandomSuffix: true,
        });
        uploaded.url = blob.url;
      } catch (e) {
        console.error('[avatar-upload] blob put failed', e);
        // The old file is already gone, so the account no longer has a photo.
        if (replaced) await tx.update(users).set({ avatarUrl: null }).where(eq(users.id, session.userId));
        return 'storage_unavailable';
      }

      const [updated] = await tx
        .update(users)
        .set({ avatarUrl: uploaded.url })
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
      return updated;
    });
  } catch (e) {
    if (e instanceof PhotoNotReplaced) return Response.json({ error: 'photo_not_replaced' }, { status: 503 });
    // The new file was stored but never committed to the account: delete it (best effort).
    if (uploaded.url) await del(uploaded.url).catch((err) => console.warn('[avatar-upload] new blob delete failed after rollback', err));
    throw e;
  }

  if (result === 'unauthorized' || result === undefined) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (result === 'storage_unavailable') {
    return Response.json({ error: 'storage_unavailable' }, { status: 502 });
  }
  const row = result;

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
