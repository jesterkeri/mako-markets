// ----------------------------------------------------------------------------
// Unit tests for isOwnedAvatarBlobUrl — the "trusted, user-owned Vercel Blob
// avatar" gate shared by the avatar-upload cleanup and the #182 comments read
// filter. A false positive here would let a legacy attacker-host avatar_url
// reach a public <img src>, so the negative cases are the load-bearing ones.
// ----------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { isOwnedAvatarBlobUrl } from '@/lib/avatar-url';

const UID = '11111111-1111-4111-8111-111111111111';

describe('isOwnedAvatarBlobUrl', () => {
  it('accepts a Vercel Blob URL under this user own /avatars/<id>/ prefix', () => {
    expect(
      isOwnedAvatarBlobUrl(
        `https://abc123.public.blob.vercel-storage.com/avatars/${UID}/x.webp`,
        UID,
      ),
    ).toBe(true);
    // The non-`public.` blob host is also accepted.
    expect(
      isOwnedAvatarBlobUrl(
        `https://abc123.blob.vercel-storage.com/avatars/${UID}/x.webp`,
        UID,
      ),
    ).toBe(true);
  });

  it('rejects an arbitrary attacker host (the legacy-paste threat)', () => {
    expect(isOwnedAvatarBlobUrl('https://attacker.example/track.webp', UID)).toBe(false);
    // Host that merely CONTAINS the blob domain as a prefix, not a suffix.
    expect(
      isOwnedAvatarBlobUrl('https://blob.vercel-storage.com.evil.com/avatars/' + UID + '/x', UID),
    ).toBe(false);
  });

  it("rejects a Vercel Blob URL under a DIFFERENT user's prefix", () => {
    expect(
      isOwnedAvatarBlobUrl(
        'https://abc.public.blob.vercel-storage.com/avatars/someone-else/x.webp',
        UID,
      ),
    ).toBe(false);
  });

  it('rejects a Vercel Blob URL with no /avatars/ path', () => {
    expect(
      isOwnedAvatarBlobUrl('https://abc.public.blob.vercel-storage.com/other/x.webp', UID),
    ).toBe(false);
  });

  it('rejects non-https, malformed, and empty inputs', () => {
    expect(
      isOwnedAvatarBlobUrl(`http://abc.public.blob.vercel-storage.com/avatars/${UID}/x`, UID),
    ).toBe(false);
    expect(isOwnedAvatarBlobUrl('not a url', UID)).toBe(false);
    expect(isOwnedAvatarBlobUrl('', UID)).toBe(false);
  });
});
