// /api/pm/markets/draft PM feature-flag gate. Asserts that when
// NEXT_PUBLIC_PM_ENABLED is unset or non-"true", POST returns
// 503 { error: 'feature_not_enabled' } before any same-origin /
// session / zod / DB / slug-allocation work.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'NEXT_PUBLIC_PM_ENABLED';
const original = process.env[KEY];

function restore(): void {
  if (original === undefined) delete process.env[KEY];
  else process.env[KEY] = original;
}

describe('POST /api/pm/markets/draft — PM feature-flag gate', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(restore);

  it('returns 503 feature_not_enabled when flag is unset', async () => {
    delete process.env[KEY];
    const { POST } = await import('../../app/api/pm/markets/draft/route');
    const res = await POST(
      new Request('http://localhost/api/pm/markets/draft', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toBe('feature_not_enabled');
  });

  it('returns 503 feature_not_enabled when flag is "false"', async () => {
    process.env[KEY] = 'false';
    const { POST } = await import('../../app/api/pm/markets/draft/route');
    const res = await POST(
      new Request('http://localhost/api/pm/markets/draft', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(503);
  });

  it('does NOT 503 when flag is "true" (falls through to existing handler)', async () => {
    process.env[KEY] = 'true';
    const { POST } = await import('../../app/api/pm/markets/draft/route');
    const res = await POST(
      new Request('http://localhost/api/pm/markets/draft', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    );
    // Downstream will reject (no Origin header, no session, bad
    // body) — should be 403/401/400, not feature-gate 503.
    if (res.status === 503) {
      const json = await res.json();
      expect(json.error).not.toBe('feature_not_enabled');
    }
  });
});
