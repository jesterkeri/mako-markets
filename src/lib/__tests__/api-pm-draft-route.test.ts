// ----------------------------------------------------------------------------
// src/lib/__tests__/api-pm-draft-route.test.ts
//
// Route-level wiring test for POST /api/pm/markets/draft, covering the
// gates added in the Codex 2C-1 r3 review:
//
//   - MAJ-1: same-origin gate (checkSameOrigin) is the FIRST step;
//     cross-origin requests are rejected with 403 BEFORE any
//     session/DB work.
//   - MAJ-2: in-flight gate. Requests whose Safe already has an
//     aa_pending_user_ops row in flight are rejected with 423
//     BEFORE allocatePmDraft is called — no pm_markets row gets
//     inserted in this path.
//   - Pending-cap surface: allocatePmDraft returning
//     { kind: 'pending_cap', count } maps to 429 with the count
//     echoed in the body.
//
// Boundary mocks: getUserSession, the userSafes select, the
// loadInFlightForSafe DAO call, and allocatePmDraft itself are all
// stubbed via vi.hoisted. The route file is imported AFTER the mocks
// register so the routes pick up the stubs (mirrors
// api-aa-sponsor-route-pm.test.ts).
// ----------------------------------------------------------------------------

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { PM_CONTRACT_ADDRESS } from '../contract';

// #180 PM gate (draft route Step -1): the gate rejects all POSTs
// with 503 when NEXT_PUBLIC_PM_ENABLED is not "true". This file's
// tests exercise the POST-gate dispatch path, so set the flag
// before the route module imports, and restore the original
// value at file teardown so the flag doesn't leak into later
// test files in the same Vitest worker.
const PM_FLAG_KEY = 'NEXT_PUBLIC_PM_ENABLED';
const PM_FLAG_ORIGINAL = process.env[PM_FLAG_KEY];
beforeAll(() => {
  process.env[PM_FLAG_KEY] = 'true';
});
afterEach(() => {
  process.env[PM_FLAG_KEY] = 'true';
});
afterAll(() => {
  if (PM_FLAG_ORIGINAL === undefined) delete process.env[PM_FLAG_KEY];
  else process.env[PM_FLAG_KEY] = PM_FLAG_ORIGINAL;
});

const SAFE = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const NONCE =
  '0x1111111111111111111111111111111111111111111111111111111111111111';

const mocks = vi.hoisted(() => ({
  checkSameOrigin: vi.fn(),
  getUserSession: vi.fn(),
  selectFromUserSafes: vi.fn(),
  loadInFlightForSafe: vi.fn(),
  allocatePmDraft: vi.fn(),
}));

vi.mock('@/lib/csrf', () => ({
  checkSameOrigin: (req: Request) => mocks.checkSameOrigin(req),
}));
vi.mock('@/lib/user-session', () => ({
  getUserSession: () => mocks.getUserSession(),
}));
vi.mock('@/db/client', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => mocks.selectFromUserSafes(),
        }),
      }),
    }),
    transaction: async (fn: (tx: unknown) => unknown) => fn({}),
  },
}));
vi.mock('@/lib/aa-pending-user-ops', () => ({
  loadInFlightForSafe: (args: unknown) => mocks.loadInFlightForSafe(args),
}));
vi.mock('@/lib/private-markets/draft', () => ({
  allocatePmDraft: (args: unknown) => mocks.allocatePmDraft(args),
}));

import { POST } from '@/app/api/pm/markets/draft/route';

function makeReq(body: unknown): Request {
  return new Request('https://example.test/api/pm/markets/draft', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function happyBody(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    chainId: 10143,
    contractAddress: PM_CONTRACT_ADDRESS,
    shape: 'friendly',
    clientNonce: NONCE,
    commentsEnabled: true,
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/pm/markets/draft — CSRF gate (Codex 2C-1 r3 MAJ-1)', () => {
  it('rejects cross-origin requests with 403 BEFORE session lookup', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: false, reason: 'mismatch' });

    const res = await POST(makeReq(happyBody()));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: 'cross_origin' });
    // Critical: no session / DB work should have happened.
    expect(mocks.getUserSession).not.toHaveBeenCalled();
    expect(mocks.selectFromUserSafes).not.toHaveBeenCalled();
    expect(mocks.loadInFlightForSafe).not.toHaveBeenCalled();
    expect(mocks.allocatePmDraft).not.toHaveBeenCalled();
  });

  it('rejects when Origin header is missing (no_origin) with 403', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: false, reason: 'no_origin' });

    const res = await POST(makeReq(happyBody()));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: 'cross_origin' });
  });
});

describe('POST /api/pm/markets/draft — in-flight gate (Codex 2C-1 r3 MAJ-2)', () => {
  it('rejects with 423 when loadInFlightForSafe returns a row, BEFORE allocatePmDraft runs', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue({
      authType: 'magic',
      userId: 'user-1',
      magicEoa: '0x1111111111111111111111111111111111111111',
    });
    mocks.selectFromUserSafes.mockResolvedValue([{ safeAddress: SAFE }]);
    mocks.loadInFlightForSafe.mockResolvedValue({
      id: 'op-1',
      status: 'pending',
    });

    const res = await POST(makeReq(happyBody()));

    expect(res.status).toBe(423);
    const body = await res.json();
    expect(body.error).toBe('aa_in_flight');
    expect(body.status).toBe('pending');
    // Critical: draft helper must NOT have been called.
    expect(mocks.allocatePmDraft).not.toHaveBeenCalled();
  });

  it('passes through to allocatePmDraft when no in-flight op exists', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue({
      authType: 'magic',
      userId: 'user-1',
      magicEoa: '0x1111111111111111111111111111111111111111',
    });
    mocks.selectFromUserSafes.mockResolvedValue([{ safeAddress: SAFE }]);
    mocks.loadInFlightForSafe.mockResolvedValue(null);
    mocks.allocatePmDraft.mockResolvedValue({
      ok: true,
      value: {
        pendingDbId: 'row-1',
        slug: 'AB12CD34',
        clientNonce: NONCE,
      },
    });

    const res = await POST(makeReq(happyBody()));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      pendingDbId: 'row-1',
      slug: 'AB12CD34',
      clientNonce: NONCE,
    });
    expect(mocks.loadInFlightForSafe).toHaveBeenCalledWith({
      chainId: 10143,
      safeAddress: SAFE.toLowerCase(),
    });
    // #182 Slice B: the comments toggle is forwarded verbatim to the
    // draft allocator so it lands on the pending row.
    expect(mocks.allocatePmDraft).toHaveBeenCalledWith(
      expect.objectContaining({ commentsEnabled: true }),
    );
  });

  it('forwards commentsEnabled=false through to allocatePmDraft', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue({
      authType: 'magic',
      userId: 'user-1',
      magicEoa: '0x1111111111111111111111111111111111111111',
    });
    mocks.selectFromUserSafes.mockResolvedValue([{ safeAddress: SAFE }]);
    mocks.loadInFlightForSafe.mockResolvedValue(null);
    mocks.allocatePmDraft.mockResolvedValue({
      ok: true,
      value: { pendingDbId: 'row-1', slug: 'AB12CD34', clientNonce: NONCE },
    });

    const res = await POST(makeReq(happyBody({ commentsEnabled: false })));
    expect(res.status).toBe(200);
    expect(mocks.allocatePmDraft).toHaveBeenCalledWith(
      expect.objectContaining({ commentsEnabled: false }),
    );
  });
});

describe('POST /api/pm/markets/draft — commentsEnabled schema (#182 Slice B)', () => {
  it('400s when commentsEnabled is missing (required field)', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue({
      authType: 'magic',
      userId: 'user-1',
      magicEoa: '0x1111111111111111111111111111111111111111',
    });

    const body = happyBody();
    delete (body as Record<string, unknown>).commentsEnabled;
    const res = await POST(makeReq(body));

    expect(res.status).toBe(400);
    // Schema rejected BEFORE any draft allocation.
    expect(mocks.allocatePmDraft).not.toHaveBeenCalled();
  });

  it('400s when commentsEnabled is a non-boolean', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue({
      authType: 'magic',
      userId: 'user-1',
      magicEoa: '0x1111111111111111111111111111111111111111',
    });

    const res = await POST(makeReq(happyBody({ commentsEnabled: 'yes' })));
    expect(res.status).toBe(400);
    expect(mocks.allocatePmDraft).not.toHaveBeenCalled();
  });
});

describe('POST /api/pm/markets/draft — pending-cap surface (Codex 2C-1 r3 MAJ-2)', () => {
  it('maps allocatePmDraft pending_cap to 429 with count echoed', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue({
      authType: 'magic',
      userId: 'user-1',
      magicEoa: '0x1111111111111111111111111111111111111111',
    });
    mocks.selectFromUserSafes.mockResolvedValue([{ safeAddress: SAFE }]);
    mocks.loadInFlightForSafe.mockResolvedValue(null);
    mocks.allocatePmDraft.mockResolvedValue({
      ok: false,
      error: { kind: 'pending_cap', count: 10 },
    });

    const res = await POST(makeReq(happyBody()));

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body).toEqual({
      error: 'pm_draft_pending_cap',
      count: 10,
    });
  });

  it('still maps duplicate -> 409 and slug_exhausted -> 500', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue({
      authType: 'magic',
      userId: 'user-1',
      magicEoa: '0x1111111111111111111111111111111111111111',
    });
    mocks.selectFromUserSafes.mockResolvedValue([{ safeAddress: SAFE }]);
    mocks.loadInFlightForSafe.mockResolvedValue(null);

    mocks.allocatePmDraft.mockResolvedValueOnce({
      ok: false,
      error: { kind: 'duplicate' },
    });
    const dup = await POST(makeReq(happyBody()));
    expect(dup.status).toBe(409);

    mocks.allocatePmDraft.mockResolvedValueOnce({
      ok: false,
      error: { kind: 'slug_exhausted' },
    });
    const sluX = await POST(makeReq(happyBody()));
    expect(sluX.status).toBe(500);
  });
});
