// checkShortcut (remembered browsers): only a readable answer counts. No answer (network, 5xx, a server without the
// route as after a rollback) is `unavailable`, never "send an email code"; an expired Privy token (401) is an email
// code; a lockout carries its end time.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { checkShortcut } from '@/lib/privy-gated-signin';

const bridge = { token: async () => 'privy-token' } as unknown as Parameters<typeof checkShortcut>[0];
const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

afterEach(() => vi.unstubAllGlobals());

describe('checkShortcut', () => {
  it.each([
    ['a missing route (404)', answer(404, { error: 'not_found' })],
    ['a server error (503)', answer(503, { error: 'unavailable' })],
    ['a cross-origin refusal (403)', answer(403, { error: 'cross_origin' })],
    ['an unknown status', answer(200, { ok: true, status: 'something_new' })],
    ['no network', vi.fn(async () => Promise.reject(new TypeError('failed to fetch')))],
  ])('%s is unavailable', async (_name, fetchMock) => {
    vi.stubGlobal('fetch', fetchMock);
    expect(await checkShortcut(bridge)).toEqual({ status: 'unavailable' });
  });

  it('an expired Privy token (401) needs an email code', async () => {
    vi.stubGlobal('fetch', answer(401, { error: 'bad_token' }));
    expect(await checkShortcut(bridge)).toEqual({ status: 'email_needed' });
  });

  it('passes the readable answers through, the lockout with its end time', async () => {
    for (const s of ['shortcut', 'bind_possible', 'rebind', 'email_needed', 'off']) {
      vi.stubGlobal('fetch', answer(200, { ok: true, status: s }));
      expect(await checkShortcut(bridge)).toEqual({ status: s });
    }
    vi.stubGlobal('fetch', answer(200, { ok: true, status: 'locked', retryAt: '2026-10-27T21:00:00.000Z' }));
    expect(await checkShortcut(bridge)).toEqual({ status: 'locked', retryAt: '2026-10-27T21:00:00.000Z' });
  });

  it('no Privy token is an email code, with no request', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect(await checkShortcut({ token: async () => null } as unknown as Parameters<typeof checkShortcut>[0])).toEqual({ status: 'email_needed' });
    expect(f).not.toHaveBeenCalled();
  });
});
