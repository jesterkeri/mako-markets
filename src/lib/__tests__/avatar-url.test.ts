// ----------------------------------------------------------------------------
// Unit tests for isOwnedAvatarBlobUrl — the "trusted, user-owned Vercel Blob
// avatar" gate shared by the avatar-upload cleanup and the #182 comments read
// filter. A false positive here would let a legacy attacker-host avatar_url
// reach a public <img src>, so the negative cases are the load-bearing ones.
// ----------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getAppBlobPublicHost,
  isAppOwnedAvatarUrl,
  isOwnedAvatarBlobUrl,
} from '@/lib/avatar-url';

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

describe('getAppBlobPublicHost (derived from BLOB_READ_WRITE_TOKEN)', () => {
  const ORIGINAL = process.env.BLOB_READ_WRITE_TOKEN;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = ORIGINAL;
  });

  it('parses the store id → <storeId>.public.blob.vercel-storage.com', () => {
    process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_Store123_thesecretpart';
    // store id is lowercased (hostnames are case-insensitive).
    expect(getAppBlobPublicHost()).toBe('store123.public.blob.vercel-storage.com');
  });

  it('returns null when the token is absent or not a rw token', () => {
    delete process.env.BLOB_READ_WRITE_TOKEN;
    expect(getAppBlobPublicHost()).toBeNull();
    process.env.BLOB_READ_WRITE_TOKEN = 'not-a-vercel-token';
    expect(getAppBlobPublicHost()).toBeNull();
    process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_'; // no store id
    expect(getAppBlobPublicHost()).toBeNull();
  });
});

describe('isAppOwnedAvatarUrl (STRICT — exact app store host)', () => {
  const ORIGINAL = process.env.BLOB_READ_WRITE_TOKEN;
  beforeEach(() => {
    // App store id = "appstore" → host appstore.public.blob.vercel-storage.com
    process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_appstore_secret';
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = ORIGINAL;
  });

  it('accepts an avatar on THIS app store host under the user own path', () => {
    expect(
      isAppOwnedAvatarUrl(
        `https://appstore.public.blob.vercel-storage.com/avatars/${UID}/x.webp`,
        UID,
      ),
    ).toBe(true);
  });

  it("rejects an ATTACKER's own Vercel Blob store (the r2 MAJOR)", () => {
    // Right suffix, right owner path, WRONG store host → rejected.
    expect(
      isAppOwnedAvatarUrl(
        `https://attacker.public.blob.vercel-storage.com/avatars/${UID}/track.webp`,
        UID,
      ),
    ).toBe(false);
  });

  it('rejects a foreign owner path even on the app store', () => {
    expect(
      isAppOwnedAvatarUrl(
        'https://appstore.public.blob.vercel-storage.com/avatars/someone-else/x.webp',
        UID,
      ),
    ).toBe(false);
  });

  it('fails closed (false) when the app host cannot be resolved', () => {
    delete process.env.BLOB_READ_WRITE_TOKEN;
    expect(
      isAppOwnedAvatarUrl(
        `https://appstore.public.blob.vercel-storage.com/avatars/${UID}/x.webp`,
        UID,
      ),
    ).toBe(false);
  });
});
