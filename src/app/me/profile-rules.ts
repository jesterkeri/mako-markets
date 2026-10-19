// The display-name and photo rules Me checks before calling the profile APIs, and the messages for what the APIs
// answer. Same rules and words as the profile page (src/components/profile/IdentityBlock.tsx and
// WalletEditableIdentity.tsx), which mirror the server's checks (src/app/api/user/profile/update/route.ts and
// src/app/api/user/avatar/upload/route.ts).

export const DISPLAY_NAME_MAX = 32;
const DISPLAY_NAME_RE = /^[A-Za-z0-9 ._-]{1,32}$/;

/// Null when the name is acceptable, otherwise the message to show.
export function validateDisplayName(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return 'Display name cannot be empty.';
  if (!DISPLAY_NAME_RE.test(trimmed)) return 'Use letters, numbers, space, dot, underscore, or dash. Max 32.';
  return null;
}

/// The message for a display-name update the server refused (`code` is the response's `error`).
export function nameSaveError(status: number, code?: string): string {
  if (status === 409 || code === 'name_taken') return NAME_TAKEN;
  if (code === 'name_reserved') return NAME_RESERVED;
  return status === 400 ? 'Display name was rejected. Try a shorter / simpler value.' : 'Update failed. Please retry.';
}

export const NAME_TAKEN = 'That name is taken. Pick another.';
export const NAME_RESERVED = 'That name is reserved. Pick another.';

const AVATAR_MAX_BYTES = 4 * 1024 * 1024;
const AVATAR_MIME_ALLOW = new Set(['image/png', 'image/jpeg', 'image/webp']);

/// Null when the file can be uploaded, otherwise the message to show.
export function avatarFileError(file: { size: number; type: string }): string | null {
  if (file.size === 0) return 'Image is empty.';
  if (file.size > AVATAR_MAX_BYTES) return 'Image too large. Max 4 MB.';
  if (!AVATAR_MIME_ALLOW.has(file.type)) return 'Use PNG, JPG, or WEBP.';
  return null;
}

/// The message for a photo upload the server refused.
export function avatarUploadError(status: number): string {
  if (status === 400) return 'Image rejected. Try a different file.';
  if (status === 401) return 'Sign-in expired. Please refresh.';
  if (status === 502) return 'Upload service unavailable. Retry shortly.';
  // The new photo could not be recorded for cleanup, so nothing changed (Codex PUBLIC_PROFILE R4 F1).
  if (status === 503) return PHOTO_NOT_REPLACED;
  return 'Upload failed. Please retry.';
}

/// The message for a photo removal the server refused.
export function avatarClearError(status: number): string {
  // The removal could not be recorded for deletion, so the photo was kept (Codex PUBLIC_PROFILE R4 F1).
  return status === 503 ? PHOTO_NOT_REMOVED : 'Clear failed. Please retry.';
}

export const PHOTO_NOT_REPLACED = "Couldn't change your photo. Try again.";
export const PHOTO_NOT_REMOVED = "Couldn't remove your photo. Try again.";
export const NETWORK_ERROR = 'Network error. Please retry.';
