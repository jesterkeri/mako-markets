import { describe, expect, it } from 'vitest';

import { BETA_SWEEP_URL, pingBetaSweep, type Fetch } from '../src/sweep';

// Owner decision Q-L (2026-10-19): exact host and path, the bypass secret in a header only, no redirects followed,
// nothing secret logged or returned.
const env = { BETA_CRON_SECRET: 'cron-secret-for-tests-0123456789', VERCEL_PROTECTION_BYPASS: 'bypass-secret-for-tests-0123456789' };
const ok = () => new Response(JSON.stringify({ ok: true, checked: 3, deleted: 2, kept: 1, failed: 0, invalid: 0, complete: true }));

function recorder(reply: () => Response | Promise<Response>) {
  const calls: { input: string; init: RequestInit }[] = [];
  const doFetch: Fetch = async (input, init) => {
    calls.push({ input, init });
    return reply();
  };
  return { calls, doFetch };
}
const secretIn = (v: unknown) => JSON.stringify(v).includes(env.BETA_CRON_SECRET) || JSON.stringify(v).includes(env.VERCEL_PROTECTION_BYPASS);

describe('pingBetaSweep', () => {
  it('calls exactly the beta sweep URL, with both secrets in headers only, never following a redirect', async () => {
    const r = recorder(ok);
    expect(await pingBetaSweep(env, r.doFetch)).toEqual({ ok: true, summary: { checked: 3, deleted: 2, failed: 0, complete: true } });
    expect(r.calls).toHaveLength(1);
    const [{ input, init }] = r.calls;
    expect(input).toBe('https://beta.makomarket.xyz/api/cron/avatar-sweep');
    expect(new URL(input).search).toBe('');
    expect(secretIn(input)).toBe(false);
    expect(init.redirect).toBe('manual');
    expect(init.method).toBe('GET');
    expect(init.headers).toEqual({ authorization: `Bearer ${env.BETA_CRON_SECRET}`, 'x-vercel-protection-bypass': env.VERCEL_PROTECTION_BYPASS });
  });

  it('the URL is a constant on the beta host, not something configurable', () => {
    expect(new URL(BETA_SWEEP_URL).host).toBe('beta.makomarket.xyz');
    expect(new URL(BETA_SWEEP_URL).pathname).toBe('/api/cron/avatar-sweep');
  });

  it('a redirect (the login wall), a 403 or a 500 is a failure, reported by status only', async () => {
    for (const status of [302, 307, 403, 500]) {
      const r = recorder(() => new Response(null, { status, headers: status < 400 ? { location: 'https://vercel.com/login' } : {} }));
      const out = await pingBetaSweep(env, r.doFetch);
      expect(out).toEqual({ ok: false, reason: 'http', status });
      expect(r.calls).toHaveLength(1);
    }
  });

  it('missing secrets: no request at all', async () => {
    for (const e of [{}, { BETA_CRON_SECRET: env.BETA_CRON_SECRET }, { VERCEL_PROTECTION_BYPASS: ' ' }]) {
      const r = recorder(ok);
      expect(await pingBetaSweep(e, r.doFetch)).toEqual({ ok: false, reason: 'secrets_missing' });
      expect(r.calls).toHaveLength(0);
    }
  });

  it('a network error or an unexpected body never carries a secret into the outcome', async () => {
    const thrower: Fetch = async (input, init) => {
      throw new Error(`failed ${input} ${JSON.stringify(init.headers)}`);
    };
    const failed = await pingBetaSweep(env, thrower);
    expect(failed).toEqual({ ok: false, reason: 'fetch_failed' });
    expect(secretIn(failed)).toBe(false);
    const odd = await pingBetaSweep(env, recorder(() => new Response('<html>login</html>')).doFetch);
    expect(odd).toEqual({ ok: false, reason: 'bad_body', status: 200 });
  });

  it('a backlog comes back as complete: false', async () => {
    const r = recorder(() => new Response(JSON.stringify({ ok: true, checked: 400, deleted: 400, failed: 0, complete: false })));
    expect(await pingBetaSweep(env, r.doFetch)).toEqual({ ok: true, summary: { checked: 400, deleted: 400, failed: 0, complete: false } });
  });
});
