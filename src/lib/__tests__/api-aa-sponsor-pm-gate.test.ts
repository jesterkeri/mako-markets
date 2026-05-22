// /api/aa/sponsor PM feature-flag gate. Asserts that pm_* kinds
// return 503 { error: 'feature_not_enabled' } when
// NEXT_PUBLIC_PM_ENABLED is unset/false, BEFORE any session
// check, zod-parse, DB read, or RPC. The gate is a single
// `kind.startsWith('pm_')` predicate so one single-call + one
// batched + one non-PM regression proves coverage; per-kind
// testing is excessive.
//
// /api/aa/send is NOT tested here — drain policy, no kind in
// the send request body. See [[mako-pm-gate]] memory.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'NEXT_PUBLIC_PM_ENABLED';
const original = process.env[KEY];

function restore(): void {
  if (original === undefined) delete process.env[KEY];
  else process.env[KEY] = original;
}

describe('POST /api/aa/sponsor — PM feature-flag gate', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(restore);

  it.each([
    ['pm_bet', { call: {} }],
    ['pm_create_market', { call: {} }],
    ['pm_bet_batched', { calls: [{}, {}] }],
  ])(
    'rejects %s with 503 feature_not_enabled when flag is unset',
    async (kind, extra) => {
      delete process.env[KEY];
      const { POST } = await import('../../app/api/aa/sponsor/route');
      const res = await POST(
        new Request('http://localhost/api/aa/sponsor', {
          method: 'POST',
          body: JSON.stringify({ kind, ...extra }),
        }),
      );
      expect(res.status).toBe(503);
      const json = await res.json();
      expect(json.error).toBe('feature_not_enabled');
    },
  );

  it('rejects pm_* even when flag is explicitly "false"', async () => {
    process.env[KEY] = 'false';
    const { POST } = await import('../../app/api/aa/sponsor/route');
    const res = await POST(
      new Request('http://localhost/api/aa/sponsor', {
        method: 'POST',
        body: JSON.stringify({ kind: 'pm_stake', call: {} }),
      }),
    );
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toBe('feature_not_enabled');
  });

  it('does NOT 503 for pm_* when flag is "true" (falls through to existing handler path)', async () => {
    process.env[KEY] = 'true';
    const { POST } = await import('../../app/api/aa/sponsor/route');
    const res = await POST(
      new Request('http://localhost/api/aa/sponsor', {
        method: 'POST',
        body: JSON.stringify({ kind: 'pm_bet', call: {} }),
      }),
    );
    // Downstream layers (same-origin, session, zod) will reject
    // because the test request lacks proper headers / auth.
    // The assertion: the rejection is NOT the feature-gate 503.
    if (res.status === 503) {
      const json = await res.json();
      expect(json.error).not.toBe('feature_not_enabled');
    }
  });

  it('non-PM kinds NOT short-circuited (gate is pm_*-specific)', async () => {
    delete process.env[KEY];
    const { POST } = await import('../../app/api/aa/sponsor/route');
    const res = await POST(
      new Request('http://localhost/api/aa/sponsor', {
        method: 'POST',
        body: JSON.stringify({ kind: 'smoke', call: {} }),
      }),
    );
    // smoke will fail at same-origin (no Origin header) or
    // session (no cookie), returning 403/401 — but MUST NOT
    // return 503 feature_not_enabled.
    if (res.status === 503) {
      const json = await res.json();
      expect(json.error).not.toBe('feature_not_enabled');
    }
  });

  it('malformed body (non-JSON) does NOT 503 — falls through to existing rejection path', async () => {
    delete process.env[KEY];
    const { POST } = await import('../../app/api/aa/sponsor/route');
    // Send a request whose body is not valid JSON. The gate's
    // try/catch should swallow the parse error and let the
    // downstream layers handle the rejection. Exact downstream
    // status depends on which gate fires first — likely 403
    // (no Origin header → same-origin reject) or 400 (zod
    // bad_body) — but it MUST NOT be 503 feature_not_enabled
    // because the gate has no kind to act on.
    const res = await POST(
      new Request('http://localhost/api/aa/sponsor', {
        method: 'POST',
        body: 'not-json',
      }),
    );
    expect(res.status).not.toBe(503);
  });
});
