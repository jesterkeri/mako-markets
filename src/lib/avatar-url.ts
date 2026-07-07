// ----------------------------------------------------------------------------
// src/lib/avatar-url.ts
//
// Single source of truth for "is this avatar_url a TRUSTED, user-OWNED Vercel
// Blob avatar?" — a Vercel Blob host AND the `/avatars/<userId>/` path prefix
// this app's upload route is the only writer of.
//
// Why it's shared (not inlined): two callers must agree byte-for-byte or a gap
// opens up —
//   1. /api/user/avatar/upload's del() cleanup (only delete blobs we own).
//   2. The comments read path (#182): `users.avatar_url` predates the upload
//      infra — migration 0004 added it as "https-only paste (no upload infra
//      in 1G)", so LEGACY rows can hold arbitrary attacker-controlled https
//      URLs. Serving those in the PUBLIC comments JSON would make every
//      viewer's browser beacon the attacker host. Current writes are locked to
//      Vercel Blob, but the legacy rows were never scrubbed — so we filter at
//      READ time and fall back to the glyph for anything not owned+Blob.
//
// Pure (only `new URL`), browser-safe — no server-only imports.
// ----------------------------------------------------------------------------

/// True iff `url` is a Vercel Blob URL under this user's own
/// `/avatars/<userId>/` prefix (the only shape the upload route writes).
/// Anything else — arbitrary hosts, another user's blob, malformed — is false.
export function isOwnedAvatarBlobUrl(url: string, userId: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    const hostMatches =
      u.hostname.endsWith('.public.blob.vercel-storage.com') ||
      u.hostname.endsWith('.blob.vercel-storage.com');
    if (!hostMatches) return false;
    return u.pathname.startsWith(`/avatars/${userId}/`);
  } catch {
    return false;
  }
}
