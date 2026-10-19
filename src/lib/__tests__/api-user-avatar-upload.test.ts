// ----------------------------------------------------------------------------
// api-user-avatar-upload.test.ts
//
// Route-level wiring tests for POST /api/user/avatar/upload. Pins:
//   - cross-origin / unauthenticated / bad-body gates
//   - file size cap (MAX_BYTES = 4 MB) + empty rejected
//   - MIME allowlist (image/png, image/jpeg, image/webp)
//   - sharp magic-byte sniff: declared type must match decoded format
//   - sharp resize pipeline invoked: rotate→resize 256x256 cover→webp
//   - the sweep-set order (Codex PUBLIC_PROFILE R4 F1, owner decision
//     Q-D 2026-10-19): the new pathname is recorded BEFORE put() (set
//     down → 503, no put); the replaced file is recorded inside the
//     locked transaction before the row changes, again after the commit,
//     then deleted best effort; the row only ever moves to a stored photo
//   - blob put failure → 502 storage_unavailable, account unchanged
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeSweepStore } from './helpers/fake-avatar-sweep';

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
  selectPriorSession: vi.fn(),
  selectCurrent: vi.fn(),
  updateSet: vi.fn(),
  updateWhere: vi.fn(),
  updateReturning: vi.fn(),
  // The order of sweep-set marks, Blob calls and transaction ends, e.g. ['mark <path>', 'put', 'commit'].
  log: [] as string[],
  sweep: null as unknown as ReturnType<typeof fakeSweepStore>,
}));
mocks.sweep = fakeSweepStore(mocks.log);
vi.mock('@/lib/envio-budget', () => ({ upstashCommand: (args: (string | number)[]) => mocks.sweep.upstash(args) }));

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
  put: (...args: unknown[]) => {
    mocks.log.push('put');
    return mocks.blobPut(...args);
  },
  del: (...args: unknown[]) => {
    mocks.log.push(`del ${String(args[0])}`);
    return mocks.blobDel(...args);
  },
  BlobNotFoundError: class extends Error {},
}));

vi.mock('@/lib/csrf', () => ({ checkSameOrigin: mocks.checkSameOrigin }));
vi.mock('@/lib/user-session', () => ({ getUserSession: mocks.getUserSession }));
vi.mock('@/lib/safe', () => ({ deriveSafeAddress: mocks.deriveSafeAddress }));

// db.transaction runs its callback with `tx` and logs 'commit' or 'rollback' (a throw). Inside it:
//   tx.select().from().where().for('update')  — the locked read of the current photo
//   tx.update().set().where()[.returning()]   — the row write
// Outside it, db.select().from().where().orderBy().limit() is the prior-session lookup.
vi.mock('@/db/client', () => {
  const tx = {
    select: () => ({ from: () => ({ where: () => ({ for: () => mocks.selectCurrent() }) }) }),
    update: () => ({
      set: (...args: unknown[]) => {
        mocks.updateSet(...args);
        return {
          where: (...w: unknown[]) => {
            mocks.updateWhere(...w);
            return { returning: () => mocks.updateReturning(), then: (ok: (v: unknown) => unknown) => ok(undefined) };
          },
        };
      },
    }),
  };
  return {
    db: {
      transaction: async (fn: (t: typeof tx) => Promise<unknown>) => {
        try {
          const out = await fn(tx);
          mocks.log.push('commit');
          return out;
        } catch (e) {
          mocks.log.push('rollback');
          throw e;
        }
      },
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: () => mocks.selectPriorSession(),
            }),
          }),
        }),
      }),
    },
  };
});

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
  inArray: (a: unknown, b: unknown) => ({ inArray: [a, b] }),
  sql: () => ({}),
}));

afterEach(() => {
  vi.clearAllMocks();
  mocks.log.length = 0;
  mocks.sweep.members.clear();
  mocks.sweep.failMark.clear();
  mocks.sweep.down = false;
});

const USER_ID = '00000000-0000-0000-0000-0000000000aa';
const OTHER_USER_ID = '00000000-0000-0000-0000-0000000000bb';
const EOA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SAFE = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const SESSION_ID = '11111111-1111-1111-1111-111111111111';

const BLOB_HOST = 'abc.public.blob.vercel-storage.com';
// The URL put() returns for a pathname: exactly that name (addRandomSuffix false).
const blobUrlOf = (pathname: string) => `https://${BLOB_HOST}/${pathname}`;
// The pathname and URL of the file the last put() stored.
const putPath = () => String(mocks.blobPut.mock.calls.at(-1)?.[0]);
const putUrl = () => blobUrlOf(putPath());
const NEW_BLOB_URL = blobUrlOf(`avatars/${USER_ID}/123-rand.webp`);

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
    authType: 'magic',
    userId: USER_ID,
    email: 'a@b.com',
    magicEoa: EOA,
    walletAddress: null,
    sessionId: SESSION_ID,
  });
  mocks.deriveSafeAddress.mockReturnValue(SAFE);
  mocks.sharpMetadata.mockResolvedValue({ format: 'png' });
  mocks.sharpToBuffer.mockResolvedValue(Buffer.from('webp-bytes'));
  mocks.blobPut.mockImplementation(async (pathname: string) => ({ url: blobUrlOf(pathname) }));
  mocks.blobDel.mockResolvedValue(undefined);
  mocks.selectPriorSession.mockResolvedValue([]);
  mocks.selectCurrent.mockResolvedValue([{ url: opts.priorAvatarUrl ?? null }]);
  const rows = [
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
  ];
  mocks.updateReturning.mockResolvedValue(rows);
  return rows;
}

// The sweep set is named per database (avatar-sweep.ts sweepKey), so the module needs one configured.
beforeEach(() => vi.stubEnv('DATABASE_URL', 'postgres://test.invalid/mako'));
afterEach(() => vi.unstubAllEnvs());

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

  it('blob put rejection → 502 storage_unavailable, the account unchanged, the attempted file still in the sweep set', async () => {
    setupHappy({ priorAvatarUrl: blobUrlOf(`avatars/${USER_ID}/old-rand.webp`) });
    mocks.blobPut.mockRejectedValue(new Error('blob api down'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { POST } = await import('../../app/api/user/avatar/upload/route');
    const res = await POST(makeRequest(makeImageFile({})));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'storage_unavailable' });
    // Nothing deleted, no DB write: the account keeps its photo.
    expect(mocks.updateSet).not.toHaveBeenCalled();
    expect(mocks.blobDel).not.toHaveBeenCalled();
    expect([...mocks.sweep.members.keys()]).toEqual([putPath()]);
    err.mockRestore();
  });

  it('the sweep set down before the upload → 503 sweep_unavailable: no put, no row write, nothing deleted', async () => {
    setupHappy({ priorAvatarUrl: blobUrlOf(`avatars/${USER_ID}/old-rand.webp`) });
    mocks.sweep.down = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { POST } = await import('../../app/api/user/avatar/upload/route');
    const res = await POST(makeRequest(makeImageFile({})));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'sweep_unavailable' });
    expect(mocks.blobPut).not.toHaveBeenCalled();
    expect(mocks.blobDel).not.toHaveBeenCalled();
    expect(mocks.updateSet).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('put() stores under the exact recorded name, recorded before the call: avatars/<userId>/<uuid>.webp, no random suffix', async () => {
    setupHappy();
    const { POST } = await import('../../app/api/user/avatar/upload/route');
    expect((await POST(makeRequest(makeImageFile({})))).status).toBe(200);
    const [pathname, , options] = mocks.blobPut.mock.calls[0] as [string, unknown, Record<string, unknown>];
    expect(pathname).toMatch(new RegExp(`^avatars/${USER_ID}/[0-9a-f-]{36}\\.webp$`));
    expect(options).toMatchObject({ access: 'public', contentType: 'image/webp', addRandomSuffix: false });
    expect(mocks.log.slice(0, 2)).toEqual([`mark ${pathname}`, 'put']);
  });

  it('put() answering a URL under another name → 502, the account unchanged', async () => {
    setupHappy();
    mocks.blobPut.mockImplementation(async (pathname: string) => ({ url: blobUrlOf(pathname.replace('.webp', '-x.webp')) }));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { POST } = await import('../../app/api/user/avatar/upload/route');
    expect((await POST(makeRequest(makeImageFile({})))).status).toBe(502);
    expect(mocks.updateSet).not.toHaveBeenCalled();
    err.mockRestore();
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
    expect(setArg).toEqual({ avatarUrl: putUrl() });
  });

  it('upload path uses avatars/<sessionUserId>/ prefix', async () => {
    setupHappy();
    const { POST } = await import('../../app/api/user/avatar/upload/route');
    await POST(makeRequest(makeImageFile({})));
    const putArg = mocks.blobPut.mock.calls[0][0] as string;
    expect(putArg.startsWith(`avatars/${USER_ID}/`)).toBe(true);
  });

  it('session points to a deleted user (locked read finds no row) → 401, nothing deleted, the stored file left to the sweep', async () => {
    setupHappy();
    mocks.selectCurrent.mockResolvedValue([]);
    const { POST } = await import('../../app/api/user/avatar/upload/route');
    const res = await POST(makeRequest(makeImageFile({})));
    expect(res.status).toBe(401);
    expect([...mocks.sweep.members.keys()]).toEqual([putPath()]);
    expect(mocks.blobDel).not.toHaveBeenCalled();
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });

  describe('prior-blob cleanup ownership scoping', () => {
    it('own prior photo: recorded in the set inside the locked transaction, again after the commit, then deleted', async () => {
      const ownPrior =
        `https://abc.public.blob.vercel-storage.com/avatars/${USER_ID}/old-rand.webp`;
      const oldPath = `avatars/${USER_ID}/old-rand.webp`;
      setupHappy({ priorAvatarUrl: ownPrior });
      const { POST } = await import('../../app/api/user/avatar/upload/route');
      const res = await POST(makeRequest(makeImageFile({})));
      expect(res.status).toBe(200);
      expect(mocks.log).toEqual([`mark ${putPath()}`, 'put', `mark ${oldPath}`, 'commit', `mark ${oldPath}`, `del ${ownPrior}`]);
      expect(mocks.blobDel.mock.calls).toEqual([[ownPrior]]);
      expect(mocks.updateSet.mock.calls).toEqual([[{ avatarUrl: putUrl() }]]);
      expect([...mocks.sweep.members.keys()].sort()).toEqual([oldPath, putPath()].sort());
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

    // Codex PUBLIC_PROFILE R4 F1: the photo is replaced through the sweep set, so no failure leaves a file untracked
    // and the account only ever points at a stored photo.
    const ownPrior = `https://abc.public.blob.vercel-storage.com/avatars/${USER_ID}/old-rand.webp`;
    const oldPath = `avatars/${USER_ID}/old-rand.webp`;

    it('the replaced file cannot be recorded: rolled back, 503, the account keeps its photo, the new file is in the set', async () => {
      setupHappy({ priorAvatarUrl: ownPrior });
      mocks.sweep.failMark.add(oldPath);
      const { POST } = await import('../../app/api/user/avatar/upload/route');
      const res = await POST(makeRequest(makeImageFile({})));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'sweep_unavailable' });
      expect(mocks.log).toEqual([`mark ${putPath()}`, 'put', `mark ${oldPath}`, 'rollback']);
      expect(mocks.updateSet).not.toHaveBeenCalled();
      expect(mocks.blobDel).not.toHaveBeenCalled();
      expect([...mocks.sweep.members.keys()]).toEqual([putPath()]);
    });

    it('the cleanup delete fails after the commit: still 200, the old file stays in the set for the sweep', async () => {
      setupHappy({ priorAvatarUrl: ownPrior });
      mocks.blobDel.mockRejectedValueOnce(new Error('blob down'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { POST } = await import('../../app/api/user/avatar/upload/route');
      expect((await POST(makeRequest(makeImageFile({})))).status).toBe(200);
      expect(mocks.sweep.members.has(oldPath)).toBe(true);
      warn.mockRestore();
    });

    it('the re-mark and the delete both fail after the commit: still 200, the old file is in the set from inside the transaction', async () => {
      setupHappy({ priorAvatarUrl: ownPrior });
      const { POST } = await import('../../app/api/user/avatar/upload/route');
      // The first mark of the old file (inside the transaction) lands; the second fails, and so does the delete.
      let marks = 0;
      const upstash = mocks.sweep.upstash;
      mocks.sweep.upstash = async (args) => {
        if (String(args[4]) === oldPath && ++marks === 2) throw new Error('upstash refused');
        return upstash(args);
      };
      mocks.blobDel.mockRejectedValueOnce(new Error('blob down'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        expect((await POST(makeRequest(makeImageFile({})))).status).toBe(200);
      } finally {
        mocks.sweep.upstash = upstash;
      }
      expect(mocks.sweep.members.has(oldPath)).toBe(true);
      warn.mockRestore();
    });

    it('the database write fails after the put: the error propagates, nothing is deleted, both files are in the set', async () => {
      setupHappy({ priorAvatarUrl: ownPrior });
      mocks.updateReturning.mockRejectedValueOnce(new Error('connection lost'));
      const { POST } = await import('../../app/api/user/avatar/upload/route');
      await expect(POST(makeRequest(makeImageFile({})))).rejects.toThrow('connection lost');
      expect(mocks.log).toEqual([`mark ${putPath()}`, 'put', `mark ${oldPath}`, 'rollback']);
      expect(mocks.blobDel).not.toHaveBeenCalled();
      expect([...mocks.sweep.members.keys()].sort()).toEqual([oldPath, putPath()].sort());
    });
  });

  // Wallet branch: blobs land at the same `avatars/<userId>/` path,
  // but the response envelope drops every Magic-only field.
  describe('wallet session', () => {
    it('returns walletAddress + new avatarUrl + lastSignInAt; magic-only fields ABSENT', async () => {
      const WALLET = '0x5555555555555555555555555555555555555555';
      mocks.checkSameOrigin.mockReturnValue({ ok: true });
      mocks.getUserSession.mockResolvedValue({
        authType: 'wallet',
        userId: USER_ID,
        email: null,
        magicEoa: null,
        walletAddress: WALLET,
        sessionId: SESSION_ID,
      });
      mocks.sharpMetadata.mockResolvedValue({ format: 'png' });
      mocks.sharpToBuffer.mockResolvedValue(Buffer.from('webp-bytes'));
      mocks.blobPut.mockImplementation(async (pathname: string) => ({ url: blobUrlOf(pathname) }));
      mocks.selectPriorSession.mockResolvedValue([]);
      mocks.selectCurrent.mockResolvedValue([{ url: null }]);
      // Same shape as Magic UPDATE projection — populated with leak-bait
      // values so a regression that spreads `row` into the response
      // would surface here.
      mocks.updateReturning.mockResolvedValue([
        {
          email: 'leak@example.com',
          magicEoa: '0xleak',
          displayName: 'WalletJoshua',
          avatarUrl: NEW_BLOB_URL,
          totpSecret: 'leak:enc',
          totpEnabledAt: new Date('2026-04-15T00:00:00Z'),
          lastEmailChangedAt: new Date('2026-04-15T00:00:00Z'),
        },
      ]);

      const { POST } = await import('../../app/api/user/avatar/upload/route');
      const res = await POST(makeRequest(makeImageFile({})));
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual([
        'authType',
        'authed',
        'avatarUrl',
        'displayName',
        'lastSignInAt',
        'ok',
        'walletAddress',
      ]);
      expect(body.authType).toBe('wallet');
      expect(body.walletAddress).toBe(WALLET);
      expect(body.avatarUrl).toBe(NEW_BLOB_URL);
      expect(body).not.toHaveProperty('email');
      expect(body).not.toHaveProperty('magicEoa');
      expect(body).not.toHaveProperty('safeAddress');
      expect(body).not.toHaveProperty('totpEnabled');
      expect(body).not.toHaveProperty('totpEnabledAt');
      expect(body).not.toHaveProperty('nextEmailChangeAvailableAt');
      expect(mocks.deriveSafeAddress).not.toHaveBeenCalled();
      // Blob path is keyed off session.userId — same convention for both
      // shapes, no per-authType branching expected.
      const putArg = mocks.blobPut.mock.calls[0][0] as string;
      expect(putArg.startsWith(`avatars/${USER_ID}/`)).toBe(true);
    });
  });
});
