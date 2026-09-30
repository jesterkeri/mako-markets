// Me's name and photo checks must match what the profile APIs accept, with the profile page's words.

import { describe, expect, it } from 'vitest';

import { avatarFileError, avatarUploadError, nameSaveError, validateDisplayName } from '@/app/me/profile-rules';

describe('validateDisplayName', () => {
  it('accepts what the update route accepts: 1 to 32 of letters, digits, space, dot, underscore, dash (trimmed)', () => {
    expect(validateDisplayName('joshua')).toBeNull();
    expect(validateDisplayName('  Joshua Z.  ')).toBeNull();
    expect(validateDisplayName('a_b-c.d 1')).toBeNull();
    expect(validateDisplayName('x'.repeat(32))).toBeNull();
  });

  it('refuses an empty name, other characters, and more than 32', () => {
    expect(validateDisplayName('   ')).toBe('Display name cannot be empty.');
    expect(validateDisplayName('josh!')).toBe('Use letters, numbers, space, dot, underscore, or dash. Max 32.');
    expect(validateDisplayName('@joshua')).toBe('Use letters, numbers, space, dot, underscore, or dash. Max 32.');
    expect(validateDisplayName('x'.repeat(33))).toBe('Use letters, numbers, space, dot, underscore, or dash. Max 32.');
  });

  it('words a refused save by status', () => {
    expect(nameSaveError(400)).toBe('Display name was rejected. Try a shorter / simpler value.');
    expect(nameSaveError(500)).toBe('Update failed. Please retry.');
  });
});

describe('photo checks', () => {
  it('takes PNG, JPG or WEBP up to 4 MB, as the upload route does', () => {
    expect(avatarFileError({ size: 4 * 1024 * 1024, type: 'image/webp' })).toBeNull();
    expect(avatarFileError({ size: 0, type: 'image/png' })).toBe('Image is empty.');
    expect(avatarFileError({ size: 4 * 1024 * 1024 + 1, type: 'image/png' })).toBe('Image too large. Max 4 MB.');
    expect(avatarFileError({ size: 10, type: 'image/gif' })).toBe('Use PNG, JPG, or WEBP.');
  });

  it('words a refused upload by status', () => {
    expect(avatarUploadError(400)).toBe('Image rejected. Try a different file.');
    expect(avatarUploadError(401)).toBe('Sign-in expired. Please refresh.');
    expect(avatarUploadError(502)).toBe('Upload service unavailable. Retry shortly.');
    expect(avatarUploadError(500)).toBe('Upload failed. Please retry.');
  });
});
