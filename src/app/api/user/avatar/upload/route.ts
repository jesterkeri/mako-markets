import { type Address } from 'viem';
import { and, desc, eq, ne } from 'drizzle-orm';
import { put, del } from '@vercel/blob';
import sharp from 'sharp';

import { db } from '@/db/client';
import { sessions, users } from '@/db/schema';
import { checkSameOrigin } from '@/lib/csrf';
import { deriveSafeAddress } from '@/lib/safe';
import { getUserSession } from '@/lib/user-session';
import { userToWire } from '@/lib/users-wire';

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
//   5. put() to Vercel Blob at avatars/<userId>/<unique>.webp, public.
//   6. If prior avatar_url is a Vercel Blob URL, del() the old blob.
//      Failures here are logged but don't fail the request — the new
//      upload is what matters; orphan blobs are cleaned by a later cron
//      (out of scope for this PR).
//   7. Update users.avatar_url to the new URL.
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

  const path = `avatars/${session.userId}/${Date.now()}.webp`;
  let uploadUrl: string;
  try {
    const blob = await put(path, resized, {
      access: 'public',
      contentType: 'image/webp',
      addRandomSuffix: true,
    });
    uploadUrl = blob.url;
  } catch (e) {
    console.error('[avatar-upload] blob put failed', e);
    return Response.json({ error: 'storage_unavailable' }, { status: 502 });
  }

  // Read prior URL so we can clean up the old blob after the DB row is
  // updated. Done before the UPDATE so we capture the value being
  // replaced even if the UPDATE returns the new value in `returning()`.
  const priorRow = await db
    .select({ avatarUrl: users.avatarUrl })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);
  const priorAvatarUrl = priorRow[0]?.avatarUrl ?? null;

  const updated = await db
    .update(users)
    .set({ avatarUrl: uploadUrl })
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
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  const row = updated[0];

  if (priorAvatarUrl && isVercelBlobUrl(priorAvatarUrl)) {
    void del(priorAvatarUrl).catch((e) => {
      console.warn('[avatar-upload] prior blob delete failed', e);
    });
  }

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

function isVercelBlobUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname.endsWith('.public.blob.vercel-storage.com')
      || u.hostname.endsWith('.blob.vercel-storage.com');
  } catch {
    return false;
  }
}
