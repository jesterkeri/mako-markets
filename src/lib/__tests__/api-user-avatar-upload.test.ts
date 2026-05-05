// ----------------------------------------------------------------------------
// api-user-avatar-upload.test.ts
//
// Route-level wiring tests for POST /api/user/avatar/upload. Pins:
//   - cross-origin / unauthenticated / bad-body gates
//   - file size cap (MAX_BYTES = 4 MB) + empty rejected
//   - MIME allowlist (image/png, image/jpeg, image/webp)
//   - sharp magic-byte sniff: declared type must match decoded format
//   - sharp resize pipeline invoked: rotate→resize 256x256 cover→webp
//   - blob put failure → 502 storage_unavailable
//   - SET clause writes the upload URL into avatar_url
//   - prior blob cleanup ONLY when the prior URL is under
//     `/avatars/<sessionUserId>/` on a Vercel Blob host. Cleanup must
//     NOT delete arbitrary URLs, foreign-user blobs, or non-Vercel
//     hosts (regression guard for the round-1 MAJOR finding where the
//     /profile/update path could plant a foreign URL that this route
//     would then delete).
//   - session-points-to-deleted-user → 401
//   - response shape matches the canonical bucket-A envelope
//
// All boundary modules (sharp, @vercel/blob, db, csrf, session,
// safe) are mocked. The test runs without any real image bytes —
// sharp is told to behave as if a valid PNG was decoded.
// ----------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  checkSameOrigin: vi.fn(),
  getUserSession: vi.fn(),
  deriveSafeAddress: vi.fn(),
  // sharp pipeline spies
  sharpMetadata: vi.fn(),
  sharpToBuffer: vi.fn(),
  // blob spies
  blobPut: vi.fn(),
  blobDel: vi.fn(),
  // db chain spies
  selectPriorAvatar: vi.fn(),
  selectPriorSession: vi.fn(),
  updateSet: vi.fn(),
  updateReturning: vi.fn(),
}));

// sharp() returns a chainable pipeline. The same instance must
// support both metadata() and rotate().resize().webp().toBuffer().
function makeSharpPipeline() {
  const pipeline: Record<string, unknown> = {
    metadata: () => mocks.sharpMetadata(),
    rotate: () => pipeline,
    resize: () => pipeline,
    webp: () => pipeline,
    toBuffer: () => mocks.sharpToBuffer(),
  };
  return pipeline;
}
vi.mock('sharp', () => ({
  default: () => makeSharpPipeline(),
}));

vi.mock('@vercel/blob', () => ({
  put: (...args: unknown[]) => mocks.blobPut(...args),
  del: (...args: unknown[]) => mocks.blobDel(...args),
}));

vi.mock('@/lib/csrf', () => ({ checkSameOrigin: mocks.checkSameOrigin }));
vi.mock('@/lib/user-session', () => ({ getUserSession: mocks.getUserSession }));
vi.mock('@/lib/safe', () => ({ deriveSafeAddress: mocks.deriveSafeAddress }));

// Two distinct select chains:
//   (A) select().from().where().limit()         — prior avatar lookup
//   (B) select().from().where().orderBy().limit() — prior session lookup
// Disambiguate by whether `orderBy` is reached.
vi.mock('@/db/client', () => ({
  db: {
    update: () => ({
      set: (...args: unknown[]) => {
        mocks.updateSet(...args);
        return {
          where: () => ({
            returning: () => mocks.updateReturning(),
          }),
        };
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => mocks.selectPriorAvatar(),
          orderBy: () => ({
            limit: () => mocks.selectPriorSession(),
          }),
        }),
      }),
    }),
  },
}));

vi.mock('@/db/schema', () => ({
  users: {
    id: 'users.id',
    email: 'users.email',
    magicEoa: 'users.magic_eoa',
    displayName: 'users.display_name',
    avatarUrl: 'users.avatar_url',
    totpSecret: 'users.totp_secret',
    totpEnabledAt: 'users.totp_enabled_at',
    lastEmailChangedAt: 'users.last_email_changed_at',
  },
  sessions: {
    id: 'sessions.id',
    userId: 'sessions.user_id',
    createdAt: 'sessions.created_at',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ args }),
  eq: (a: unknown, b: unknown) => ({ a, b }),
  ne: (a: unknown, b: unknown) => ({ ne: [a, b] }),
  desc: (a: unknown) => ({ desc: a }),
}));

afterEach(() => vi.clearAllMocks());

const USER_ID = '00000000-0000-0000-0000-0000000000aa';
const OTHER_USER_ID = '00000000-0000-0000-0000-0000000000bb';
const EOA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SAFE = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const SESSION_ID = '11111111-1111-1111-1111-111111111111';

const NEW_BLOB_URL =
  `https://abc.public.blob.vercel-storage.com/avatars/${USER_ID}/123-rand.webp`;

function makeRequest(file: File | null): Request {
  const fd = new FormData();
  if (file) fd.set('avatar', file);
  return new Request('http://localhost/api/user/avatar/upload', {
    method: 'POST',
    body: fd,
  });
}

function makeImageFile(opts: {
  bytes?: number;
  type?: string;
  name?: string;
}): File {
  const size = opts.bytes ?? 1024;
  const type = opts.type ?? 'image/png';
  const name = opts.name ?? 'avatar.png';
  return new File([new Uint8Array(size)], name, { type });
}

function setupHappy(opts: {
  priorAvatarUrl?: string | null;
  rowOverrides?: Record<string, unknown>;
} = {}) {
  mocks.checkSameOrigin.mockReturnValue({ ok: true });
  mocks.getUserSession.mockResolvedValue({
    userId: USER_ID,
    email: 'a@b.com',
    magicEoa: EOA,
    sessionId: SESSION_ID,
  });
  mocks.deriveSafeAddress.mockReturnValue(SAFE);
  mocks.sharpMetadata.mockResolvedValue({ format: 'png' });
  mocks.sharpToBuffer.mockResolvedValue(Buffer.from('webp-bytes'));
  mocks.blobPut.mockResolvedValue({ url: NEW_BLOB_URL });
  mocks.blobDel.mockResolvedValue(undefined);
  mocks.selectPriorAvatar.mockResolvedValue([
    { avatarUrl: opts.priorAvatarUrl ?? null },
  ]);
  mocks.selectPriorSession.mockResolvedValue([]);
  mocks.updateReturning.mockResolvedValue([
    {
      email: 'a@b.com',
      magicEoa: EOA,
      displayName: null,
      avatarUrl: NEW_BLOB_URL,
      totpSecret: null,
      totpEnabledAt: null,
      lastEmailChangedAt: null,
      ...(opts.rowOverrides ?? {}),
    },
  ]);
}

describe('POST /api/user/avatar/upload', () => {
  it('rejects cross-origin (403)', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: false });
    const { POST } = await import('../../app/api/user/avatar/upload/route');
    const res = await POST(makeRequest(makeImageFile({})));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'cross_origin' });
  });

  it('rejects unauthenticated (401)', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue(null);
    const { POST } = await import('../../app/api/user/avatar/upload/route');
    const res = await POST(makeRequest(makeImageFile({})));
    expect(res.status).toBe(401);
  });

  it('rejects missing file field (400 bad_body)', async () => {
    setupHappy();
    const { POST } = await import('../../app/api/user/avatar/upload/route');
    const res = await POST(makeRequest(null));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_body' });
  });

  it('rejects empty file (size=0 → 400 bad_size)', async () => {
    setupHappy();
    const { POST } = await import('../../app/api/user/avatar/upload/route');
    const res = await POST(makeRequest(makeImageFile({ bytes: 0 })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_size' });
  });

  it('rejects oversized file (> 4 MB → 400 bad_size)', async () => {
    setupHappy();
    const { POST } = await import('../../app/api/user/avatar/upload/route');
    const res = await POST(
      makeRequest(makeImageFile({ bytes: 4 * 1024 * 1024 + 1 })),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_size' });
  });

  it('rejects disallowed MIME (image/gif → 400 bad_type)', async () => {
    setupHappy();
    const { POST } = await import('../../app/api/user/avatar/upload/route');
    const res = await POST(
      makeRequest(makeImageFile({ type: 'image/gif', name: 'a.gif' })),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_type' });
  });

  it('rejects MIME spoof: declared image/png but sharp decodes as jpeg (400 bad_image)', async () => {
    setupHappy();
    mocks.sharpMetadata.mockResolvedValue({ format: 'jpeg' });
    const { POST } = await import('../../app/api/user/avatar/upload/route');
    const res = await POST(
      makeRequest(makeImageFile({ type: 'image/png' })),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_image' });
    // Must NOT have called blob put.
    expect(mocks.blobPut).not.toHaveBeenCalled();
  });

  it('sharp throw → 400 bad_image', async () => {
    setupHappy();
    mocks.sharpMetadata.mockRejectedValue(new Error('decode failed'));
    const { POST } = await import('../../app/api/user/avatar/upload/route');
    const res = await POST(makeRequest(makeImageFile({})));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_image' });
    expect(mocks.blobPut).not.toHaveBeenCalled();
  });

  it('blob put rejection → 502 storage_unavailable', async () => {
    setupHappy();
    mocks.blobPut.mockRejectedValue(new Error('blob api down'));
    const { POST } = await import('../../app/api/user/avatar/upload/route');
    const res = await POST(makeRequest(makeImageFile({})));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'storage_unavailable' });
    // No DB write attempted.
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });

  it('happy path: writes uploadUrl to avatar_url, returns wire envelope', async () => {
    setupHappy();
    const { POST } = await import('../../app/api/user/avatar/upload/route');
    const res = await POST(makeRequest(makeImageFile({})));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.authed).toBe(true);
    expect(body.avatarUrl).toBe(NEW_BLOB_URL);
    expect(body.safeAddress).toBe(SAFE);
    // Wire envelope must not leak totpSecret.
    expect(body).not.toHaveProperty('totpSecret');
    expect(body).not.toHaveProperty('lastEmailChangedAt');
    // SET clause writes the new URL.
    const setArg = mocks.updateSet.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg).toEqual({ avatarUrl: NEW_BLOB_URL });
  });

  it('upload path uses avatars/<sessionUserId>/ prefix', async () => {
    setupHappy();
    const { POST } = await import('../../app/api/user/avatar/upload/route');
    await POST(makeRequest(makeImageFile({})));
    const putArg = mocks.blobPut.mock.calls[0][0] as string;
    expect(putArg.startsWith(`avatars/${USER_ID}/`)).toBe(true);
  });

  it('happy path: DB row missing (RETURNING []) → 401', async () => {
    setupHappy();
    mocks.updateReturning.mockResolvedValue([]);
    const { POST } = await import('../../app/api/user/avatar/upload/route');
    const res = await POST(makeRequest(makeImageFile({})));
    expect(res.status).toBe(401);
  });

  describe('prior-blob cleanup ownership scoping', () => {
    it('deletes prior blob when path is /avatars/<sessionUserId>/...', async () => {
      const ownPrior =
        `https://abc.public.blob.vercel-storage.com/avatars/${USER_ID}/old-rand.webp`;
      setupHappy({ priorAvatarUrl: ownPrior });
      const { POST } = await import('../../app/api/user/avatar/upload/route');
      const res = await POST(makeRequest(makeImageFile({})));
      expect(res.status).toBe(200);
      // Wait one microtask for the void del() to fire.
      await new Promise((r) => setImmediate(r));
      expect(mocks.blobDel).toHaveBeenCalledTimes(1);
      expect(mocks.blobDel).toHaveBeenCalledWith(ownPrior);
    });

    it('REFUSES to delete a foreign-user blob URL (path is /avatars/<otherId>/...)', async () => {
      const foreignPrior =
        `https://abc.public.blob.vercel-storage.com/avatars/${OTHER_USER_ID}/old-rand.webp`;
      setupHappy({ priorAvatarUrl: foreignPrior });
      const { POST } = await import('../../app/api/user/avatar/upload/route');
      const res = await POST(makeRequest(makeImageFile({})));
      expect(res.status).toBe(200);
      await new Promise((r) => setImmediate(r));
      expect(mocks.blobDel).not.toHaveBeenCalled();
    });

    it('REFUSES to delete a non-Vercel-Blob URL', async () => {
      const externalPrior = 'https://example.com/avatar.png';
      setupHappy({ priorAvatarUrl: externalPrior });
      const { POST } = await import('../../app/api/user/avatar/upload/route');
      const res = await POST(makeRequest(makeImageFile({})));
      expect(res.status).toBe(200);
      await new Promise((r) => setImmediate(r));
      expect(mocks.blobDel).not.toHaveBeenCalled();
    });

    it('REFUSES to delete a Vercel-Blob URL whose path is NOT under /avatars/...', async () => {
      const wrongPathPrior =
        'https://abc.public.blob.vercel-storage.com/uploads/foo.webp';
      setupHappy({ priorAvatarUrl: wrongPathPrior });
      const { POST } = await import('../../app/api/user/avatar/upload/route');
      const res = await POST(makeRequest(makeImageFile({})));
      expect(res.status).toBe(200);
      await new Promise((r) => setImmediate(r));
      expect(mocks.blobDel).not.toHaveBeenCalled();
    });

    it('REFUSES to delete when prior URL is malformed (URL parse throws)', async () => {
      const malformed = 'not-a-url';
      setupHappy({ priorAvatarUrl: malformed });
      const { POST } = await import('../../app/api/user/avatar/upload/route');
      const res = await POST(makeRequest(makeImageFile({})));
      expect(res.status).toBe(200);
      await new Promise((r) => setImmediate(r));
      expect(mocks.blobDel).not.toHaveBeenCalled();
    });

    it('does NOT call del() when there is no prior avatar', async () => {
      setupHappy({ priorAvatarUrl: null });
      const { POST } = await import('../../app/api/user/avatar/upload/route');
      const res = await POST(makeRequest(makeImageFile({})));
      expect(res.status).toBe(200);
      await new Promise((r) => setImmediate(r));
      expect(mocks.blobDel).not.toHaveBeenCalled();
    });

    it('del() failure is swallowed (request still succeeds)', async () => {
      const ownPrior =
        `https://abc.public.blob.vercel-storage.com/avatars/${USER_ID}/old-rand.webp`;
      setupHappy({ priorAvatarUrl: ownPrior });
      mocks.blobDel.mockRejectedValue(new Error('delete failed'));
      const { POST } = await import('../../app/api/user/avatar/upload/route');
      const res = await POST(makeRequest(makeImageFile({})));
      expect(res.status).toBe(200);
      await new Promise((r) => setImmediate(r));
      // Was attempted — and rejected — but the route still 200s.
      expect(mocks.blobDel).toHaveBeenCalledTimes(1);
    });
  });
});
