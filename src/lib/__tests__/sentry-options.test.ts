// Sentry's quota guard and privacy rules (Joshua's rule 2026-09-17; NONFUNCTIONAL_GATE O1): repeats dropped, identity
// stripped, noise ignored, off without a DSN.
import type { ErrorEvent } from '@sentry/nextjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEDUPE_WINDOW_MS, IGNORE_ERRORS, makeBeforeSend, scrub, sentryBaseOptions } from '@/lib/sentry-options';

const WALLET = '0x706cf4A1aaaaaaaaaaaaaaaaaaaaaaaaaab6A51c';
const event = (value = 'boom'): ErrorEvent =>
  ({
    type: undefined,
    exception: { values: [{ type: 'Error', value, stacktrace: { frames: [{ filename: 'app/page.tsx', function: 'f' }] } }] },
    user: { id: 'u1', email: 'a@b.co', ip_address: '1.2.3.4' },
    request: { url: `https://makomarket.xyz/u/${WALLET}?ref=x`, cookies: { s: '1' }, headers: { cookie: 's=1' }, query_string: 'ref=x', data: { email: 'a@b.co' } },
    breadcrumbs: [{ message: `sent to ${WALLET}`, data: { to: 'owner@example.com' } }],
  }) as unknown as ErrorEvent;

afterEach(() => vi.unstubAllEnvs());

describe('scrub', () => {
  it('masks emails and 0x addresses, leaves the rest', () => {
    expect(scrub(`user a.b+c@example.co.uk paid ${WALLET} ok`)).toBe('user [email] paid 0x[address] ok');
    expect(scrub('tx 0x' + 'ab'.repeat(32))).toBe('tx 0x' + 'ab'.repeat(32)); // a hash is not an address
  });
});

describe('beforeSend', () => {
  it('strips the user, cookies, headers, body and query, and masks identity everywhere', () => {
    const e = makeBeforeSend(() => 0)(event(`no balance for ${WALLET}, a@b.co`))!;
    expect(e.user).toBeUndefined();
    expect(e.request).toEqual({ url: 'https://makomarket.xyz/u/0x[address]?ref=x', query_string: '[removed]' });
    expect(e.exception!.values![0].value).toBe('no balance for 0x[address], [email]');
    expect(e.breadcrumbs![0]).toEqual({ message: 'sent to 0x[address]', data: { to: '[email]' } });
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
