// ----------------------------------------------------------------------------
// api-user-email-update-guards.test.ts
//
// Pins the entry-point guards on POST /api/user/email/update:
//   1. cross-origin → 403 cross_origin
//   2. unauthenticated → 401 unauthorized
//   3. wallet session → 400 wallet_session (codex round-8 MINOR)
//
// The full route's happy/error paths are out of scope here — this file
// exists so a future refactor that drops the wallet_session guard fails
// CI before it can ship a magic-only endpoint to wallet users.
// ----------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  checkSameOrigin: vi.fn(),
  getUserSession: vi.fn(),
  validateDidToken: vi.fn(),
  getMetadataByDidToken: vi.fn(),
}));

vi.mock('@/lib/csrf', () => ({ checkSameOrigin: mocks.checkSameOrigin }));
vi.mock('@/lib/user-session', () => ({
  getUserSession: mocks.getUserSession,
}));
vi.mock('@/lib/magic-server', () => ({
  validateDidToken: mocks.validateDidToken,
  getMetadataByDidToken: mocks.getMetadataByDidToken,
  MagicConfigError: class MagicConfigError extends Error {},
}));

afterEach(() => vi.clearAllMocks());

const USER_ID = '00000000-0000-0000-0000-0000000000aa';

function makeRequest(body: unknown = { didToken: 'fake' }) {
  return new Request('http://localhost/api/user/email/update', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/user/email/update — entry guards', () => {
  it('rejects cross-origin (403 cross_origin)', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: false });
    const { POST } = await import('../../app/api/user/email/update/route');
    const res = await POST(makeRequest());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'cross_origin' });
    // Guard precedes auth lookup.
    expect(mocks.getUserSession).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated (401 unauthorized)', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue(null);
    const { POST } = await import('../../app/api/user/email/update/route');
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('rejects wallet session with 400 wallet_session before Magic SDK work', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue({
      authType: 'wallet',
      userId: USER_ID,
      email: null,
      magicEoa: null,
      walletAddress: '0xfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed',
      sessionId: 's',
    });
    const { POST } = await import('../../app/api/user/email/update/route');
    const res = await POST(makeRequest());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'wallet_session' });
    // Guard precedes body parse + Magic admin SDK calls. A wallet user
    // hitting this route should NEVER trigger validateDidToken or any
    // metadata fetch.
    expect(mocks.validateDidToken).not.toHaveBeenCalled();
    expect(mocks.getMetadataByDidToken).not.toHaveBeenCalled();
  });
});
