// Sentry's quota guard and privacy rules (Joshua's rule 2026-09-17; NONFUNCTIONAL_GATE O1): repeats dropped, identity
// stripped, noise ignored, off without a DSN.
import type { ErrorEvent } from '@sentry/nextjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEDUPE_WINDOW_MS, IGNORE_ERRORS, makeBeforeSend, scrub, scrubDeep, scrubUrl, sentryBaseOptions } from '@/lib/sentry-options';

const WALLET = '0x706cf4A1aaaaaaaaaaaaaaaaaaaaaaaaaab6A51c';
const event = (value = 'boom'): ErrorEvent =>
  ({
    type: undefined,
    exception: { values: [{ type: 'Error', value, stacktrace: { frames: [{ filename: 'app/page.tsx', function: 'f' }] } }] },
    user: { id: 'u1', email: 'a@b.co', ip_address: '1.2.3.4' },
    request: { url: `https://makomarket.xyz/u/${WALLET}?ref=x`, cookies: { s: '1' }, headers: { cookie: 's=1' }, query_string: 'ref=x', data: { email: 'a@b.co' } },
    breadcrumbs: [
      { message: `sent to ${WALLET}`, data: { to: 'owner@example.com' } },
      { category: 'fetch', data: { url: '/api/user/me?session=abc', method: 'GET' } },
    ],
    extra: { note: `paid by ${WALLET}` },
  }) as unknown as ErrorEvent;

afterEach(() => vi.unstubAllEnvs());

describe('scrub', () => {
  it('masks emails and 0x addresses, leaves the rest', () => {
    expect(scrub(`user a.b+c@example.co.uk paid ${WALLET} ok`)).toBe('user [email] paid 0x[address] ok');
    expect(scrub('tx 0x' + 'ab'.repeat(32))).toBe('tx 0x' + 'ab'.repeat(32)); // a hash is not an address
    expect(scrub(`${WALLET}_pending`)).toBe('0x[address]_pending');
    expect(scrub('to=JOSH%40Example.COM')).toBe('to=[email]');
  });
  it('cuts the query of an absolute URL inside free text, and masks a 0X-prefixed address', () => {
    expect(scrub('fetch https://makomarket.xyz/api/x?email=a%40b.co&ref=y failed')).toBe('fetch https://makomarket.xyz/api/x failed');
    expect(scrub(`to 0X${WALLET.slice(2)}`)).toBe('to 0x[address]');
    const long = `https://a.b/${'c'.repeat(100_000)}`;
    const t0 = performance.now();
    scrub(long);
    expect(performance.now() - t0).toBeLessThan(200);
  });
  it('drops a session user agent; scrubDeep alone masks a dsn-named field (the envelope layer restores the header one)', () => {
    const dsn = 'https://0123456789abcdef0123456789abcdef@o1.ingest.us.sentry.io/2';
    const env = [{ dsn, sent_at: 'x' }, [[{ type: 'session' }, { attrs: { release: 'r', user_agent: 'Mozilla/5.0' } }]]];
    scrubDeep(env);
    expect(env).toEqual([{ dsn: 'https://[email]/2', sent_at: 'x' }, [[{ type: 'session' }, { attrs: { release: 'r' } }]]]);
  });
  it('drops the query and fragment from a URL', () => {
    expect(scrubUrl('https://makomarket.xyz/markets/84?ref=x#top')).toBe('https://makomarket.xyz/markets/84');
  });
});

describe('scrubDeep', () => {
  it('stays linear on a long run with no @ (a calldata blob in a viem error)', () => {
    const blob = 'ab'.repeat(100_000);
    const t0 = performance.now();
    scrub(blob);
    expect(performance.now() - t0).toBeLessThan(200);
  });
  it('never throws on a cycle, a bigint or a class instance, and leaves internal metadata alone', () => {
    class Scope { client = { timer: setInterval(() => undefined, 1e6) }; note = `x ${WALLET}`; }
    const scope = new Scope();
    const meta = { scope, normalizeDepth: 3, raw: `y ${WALLET}` };
    const e: Record<string, unknown> = { tags: { stake: 10n, who: WALLET }, sdkProcessingMetadata: meta };
    e.self = e;
    expect(() => scrubDeep(e)).not.toThrow();
    expect(e.tags).toEqual({ stake: 10n, who: '0x[address]' });
    expect(scope.note).toBe(`x ${WALLET}`); // a class instance is not walked
    expect(meta.raw).toBe(`y ${WALLET}`); // the SDK's own bookkeeping is never sent and never altered
    clearInterval(scope.client.timer);
  });
  it('cuts the query from a span attribute and drops user and header attributes', () => {
    const span = { name: 'GET /api/names?addresses=x', attributes: { 'url.full': { value: 'https://m.xyz/a?b=c', type: 'string' }, 'user.email': { value: 'a@b.co' }, 'http.request.header.cookie': { value: 's=1' } } };
    scrubDeep(span);
    expect(span).toEqual({ name: 'GET /api/names', attributes: { 'url.full': { value: 'https://m.xyz/a', type: 'string' } } });
  });
});

describe('beforeSend', () => {
  it('strips the user, cookies, headers, body and query, and masks identity everywhere', () => {
    const e = makeBeforeSend(() => 0)(event(`no balance for ${WALLET}, a@b.co`))!;
    expect(e.user).toBeUndefined();
    expect(e.request).toEqual({ url: 'https://makomarket.xyz/u/0x[address]', query_string: '[removed]' });
    expect(e.exception!.values![0].value).toBe('no balance for 0x[address], [email]');
    expect(e.breadcrumbs![0]).toEqual({ message: 'sent to 0x[address]', data: { to: '[email]' } });
    expect(e.breadcrumbs![1].data).toEqual({ url: '/api/user/me', method: 'GET' });
    expect(e.extra).toEqual({ note: 'paid by 0x[address]' });
  });
  it('drops the same error again inside the window, sends it after, and never drops a different one', () => {
    let t = 0;
    const send = makeBeforeSend(() => t);
    expect(send(event())).not.toBeNull();
    t = DEDUPE_WINDOW_MS - 1;
    expect(send(event())).toBeNull();
    expect(send(event('other'))).not.toBeNull();
    t = 2 * DEDUPE_WINDOW_MS;
    expect(send(event())).not.toBeNull();
  });
});

describe('options', () => {
  it('off without a DSN, on with one; never PII; sampled', () => {
    vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', '');
    expect(sentryBaseOptions()).toMatchObject({ enabled: false, sendDefaultPii: false });
    vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', 'https://k@o1.ingest.sentry.io/1');
    const o = sentryBaseOptions();
    expect(o).toMatchObject({ enabled: true, sendDefaultPii: false });
    expect(o.sampleRate).toBeLessThan(1);
    expect(o.tracesSampleRate).toBeLessThanOrEqual(0.05);
  });
  it('ignores a wallet refusal and an extension error', () => {
    const hit = (m: string) => IGNORE_ERRORS.some((p) => (typeof p === 'string' ? m.includes(p) : p.test(m)));
    expect(hit('User rejected the request.')).toBe(true);
    expect(hit('Error: MFA canceled')).toBe(true);
    expect(hit('at chrome-extension://abc/inpage.js')).toBe(true);
    expect(hit('TypeError: cannot read properties of undefined')).toBe(false);
  });
});
