import { createHash } from 'node:crypto';

/// A player's profile photo as the public sees it: served by /api/avatar/<address>, never the stored Blob URL, whose
/// `/avatars/<user_id>/` path carries the internal account id (Joshua 2026-10-17, Codex PUBLIC_PROFILE R1 M2). `v` is a
/// short hash of the stored URL, so a new photo gets a new path and shows at once (the route caches a minute at most).
export const publicAvatarPath = (address: string, storedUrl: string): string =>
  `/api/avatar/${address.toLowerCase()}?v=${avatarVersion(storedUrl)}`;

export const avatarVersion = (storedUrl: string): string => createHash('sha256').update(storedUrl).digest('hex').slice(0, 12);
