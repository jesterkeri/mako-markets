// ----------------------------------------------------------------------------
// src/lib/__tests__/cron-auth.test.ts
//
// Locks in the Bearer-only auth contract for /api/cron/aa-fast and
// /api/cron/aa-slow. Plan v6 verification §"Cron tests" matrix:
//   - no headers → 403
//   - `x-vercel-cron: 1` only (no Bearer) → 403
//   - `Authorization: Bearer wrong-secret` → 403
//   - `Authorization: Bearer ${CRON_SECRET}` (no x-vercel-cron) → 200-eligible
//   - `Authorization: Bearer ${CRON_SECRET}` + `x-vercel-cron: 1` → 200-eligible
// ----------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterAll } from 'vitest';

import { checkCronAuth, cronDiagnostics } from '../cron-auth';

const VALID_SECRET = 'test-cron-secret-32-bytes-random-blah';
const ORIGINAL_SECRET = process.env.CRON_SECRET;

beforeEach(() => {
  process.env.CRON_SECRET = VALID_SECRET;
});

afterAll(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL_SECRET;
});

function mkReq(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/cron/aa-fast', {
    method: 'GET',
    headers,
  });
}

describe('checkCronAuth', () => {
  it('rejects when no headers are present', () => {
    expect(checkCronAuth(mkReq())).toBe(false);
  });

  it('rejects x-vercel-cron alone (the spoofable diagnostic header)', () => {
    expect(checkCronAuth(mkReq({ 'x-vercel-cron': '1' }))).toBe(false);
  });

  it('rejects vercel-cron user-agent alone', () => {
    expect(
      checkCronAuth(mkReq({ 'user-agent': 'vercel-cron/1.0' })),
    ).toBe(false);
  });

  it('rejects a wrong Bearer secret', () => {
    expect(
      checkCronAuth(mkReq({ authorization: 'Bearer not-the-secret' })),
    ).toBe(false);
  });

  it('rejects a malformed Authorization header (missing scheme)', () => {
    expect(
      checkCronAuth(mkReq({ authorization: VALID_SECRET })),
    ).toBe(false);
  });

  it('rejects an empty Bearer token', () => {
    expect(
      checkCronAuth(mkReq({ authorization: 'Bearer ' })),
    ).toBe(false);
  });

  it('accepts a valid Bearer token alone (proves x-vercel-cron is NOT required)', () => {
    expect(
      checkCronAuth(mkReq({ authorization: `Bearer ${VALID_SECRET}` })),
    ).toBe(true);
  });

  it('accepts a valid Bearer token with x-vercel-cron present (the production shape)', () => {
    expect(
      checkCronAuth(
        mkReq({
          authorization: `Bearer ${VALID_SECRET}`,
          'x-vercel-cron': '1',
          'user-agent': 'vercel-cron/1.0',
        }),
      ),
    ).toBe(true);
  });

  it('rejects when CRON_SECRET env var is missing', () => {
    delete process.env.CRON_SECRET;
    expect(
      checkCronAuth(mkReq({ authorization: `Bearer ${VALID_SECRET}` })),
    ).toBe(false);
  });

  it('rejects when CRON_SECRET is too short (< 16 chars)', () => {
    process.env.CRON_SECRET = 'short';
    expect(
      checkCronAuth(mkReq({ authorization: 'Bearer short' })),
    ).toBe(false);
  });

  it('rejects when token is the right value but length differs (timingSafeEqual guard)', () => {
    // timingSafeEqual throws if lengths differ; checkCronAuth must short-
    // circuit BEFORE the call to avoid the throw becoming a 500.
    expect(
      checkCronAuth(mkReq({ authorization: `Bearer ${VALID_SECRET}x` })),
    ).toBe(false);
  });
});

describe('cronDiagnostics', () => {
  it('returns the x-vercel-cron + user-agent headers (logging only — never used as auth)', () => {
    const req = mkReq({
      'x-vercel-cron': '1',
      'user-agent': 'vercel-cron/1.0',
    });
    expect(cronDiagnostics(req)).toEqual({
      vercelCronHeader: '1',
      userAgent: 'vercel-cron/1.0',
    });
  });

  it('returns nulls when the diagnostic headers are absent', () => {
    expect(cronDiagnostics(mkReq())).toEqual({
      vercelCronHeader: null,
      userAgent: null,
    });
  });
});
