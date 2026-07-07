// ----------------------------------------------------------------------------
// src/lib/avatar-url.ts
//
// Trust helpers for `users.avatar_url`. `avatar_url` predates the upload infra —
// migration 0004 added it as "https-only paste (no upload infra in 1G)", so
// LEGACY rows can hold arbitrary attacker-controlled URLs, and those were never
// scrubbed. Two callers need to reason about which URLs to trust:
//
//   1. The comments PUBLIC read path (#182) — must serve ONLY avatars this app
//      itself produced, or a legacy pasted URL would make every viewer's
//      browser beacon a third-party host. Use `isAppOwnedAvatarUrl` (STRICT:
//      exact app store host). A Vercel Blob URL is NOT enough — an attacker can
//      spin up their own Blob store (`attacker.public.blob.vercel-storage.com`),
//      so we pin THIS app's store host specifically (Codex #182 r2 MAJOR).
//
//   2. The avatar-upload del() cleanup — deletes a user's PRIOR blob when they
//      upload a new one. Uses `isOwnedAvatarBlobUrl` (LENIENT: any Vercel Blob
//      host + this user's own path). Lenient is safe there: del() runs with the
//      app's token so it can only ever delete OUR store's blobs anyway, and the
//      path gate stops cross-user deletes. This is NOT a public-serving path.
//
// `isOwnedAvatarBlobUrl` is pure/browser-safe. `getAppBlobPublicHost` reads the
// server-only `BLOB_READ_WRITE_TOKEN` env (never exposed — only the public host
// is derived) so `isAppOwnedAvatarUrl` is server-intended; on the client the
// token is absent → it returns null → callers fall back to the glyph.
// ----------------------------------------------------------------------------

/// LENIENT — any Vercel Blob host under this user's own `/avatars/<userId>/`
/// prefix. For the upload del() cleanup only. NOT for public serving.
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

/// This app's own Vercel Blob PUBLIC host, derived from BLOB_READ_WRITE_TOKEN.
/// Token shape: `vercel_blob_rw_<storeId>_<secret>`; the public URL host is
/// `<storeId>.public.blob.vercel-storage.com` (Vercel docs). Returns null when
/// the token is missing/unparseable, so callers FAIL CLOSED (glyph, never an
/// attacker image). Hostnames are case-insensitive → lowercased.
export function getAppBlobPublicHost(): string | null {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return null;
  const m = /^vercel_blob_rw_([^_]+)_/.exec(token);
  if (!m) return null;
  return `${m[1].toLowerCase()}.public.blob.vercel-storage.com`;
}

/// STRICT — is `url` an avatar THIS app uploaded for `userId`? Requires the
/// EXACT app store host (not merely any *.blob.vercel-storage.com tenant — an
/// attacker can create their own Blob store) AND this user's own
/// `/avatars/<userId>/` path. Used for the PUBLIC comments wire. Fails closed
/// when the app host can't be resolved.
export function isAppOwnedAvatarUrl(url: string, userId: string): boolean {
  const appHost = getAppBlobPublicHost();
  if (!appHost) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    if (u.hostname.toLowerCase() !== appHost) return false;
    return u.pathname.startsWith(`/avatars/${userId}/`);
  } catch {
    return false;
  }
}
