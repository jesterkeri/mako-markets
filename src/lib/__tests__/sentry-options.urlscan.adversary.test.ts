// Adversary pass on 67fa9e0 (contract: src/lib/sentry-options.ts:52-53, "Bounded quantifiers keep the scan linear ...
// a 100,000-character hex blob took six seconds", and the commit's own test in sentry-options.test.ts, which requires a
// 100,000-character URL to scrub in under 200 ms).
//
// The new URL_QUERY_IN_TEXT (src/lib/sentry-options.ts:60) has an UNBOUNDED `[^\s?#"'<>]+` before a required `[?#]`.
// When a run of text holds many `http://` starts and no `?`, `#`, whitespace or quote, every start scans to the end of
// the run and backtracks: quadratic, the same class of defect the EMAIL bounds were added to fix. The commit's test
// uses ONE URL, so only one start exists and it never sees this.
//
// SDK fact relied on: @sentry/core 11.4.0 build/cjs/utils/prepareEvent.js:85-91 truncates exception values only when
// `maxValueLength` is set, and no 11.4.0 package sets a default, so an exception message reaches beforeSend whole.
import { describe, expect, it } from 'vitest';

import { makeBeforeSend, scrub, scrubDeep } from '@/lib/sentry-options';

// About 100,000 characters: comma-joined URLs, no whitespace, no quote, no query (a list of endpoints in one message).
const urlRun = 'http://a,'.repeat(11_112);

describe('scrub stays linear on free text holding many URLs', () => {
  it('scrubs a 100,000-character run of URLs in under 200 ms, the bound the module sets for a 100,000-character URL', () => {
    const t0 = performance.now();
    scrub(urlRun);
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it('beforeSend handles an error whose message is that run within the same bound', () => {
    const beforeSend = makeBeforeSend(() => 0);
    const event = { exception: { values: [{ type: 'Error', value: `all providers failed: ${urlRun}` }] } };
    const t0 = performance.now();
    beforeSend(event as never);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

// Lower-ranked findings on the same commit.
describe('the new skips and cuts reach exactly what their comments say', () => {
  // src/lib/sentry-options.ts:59 "An absolute URL inside free text ...: its query and fragment are cut." A URL scheme is
  // case-insensitive (RFC 3986 section 3.1), so `HTTPS://` is the same absolute URL; the regex has no `i` flag.
  it('cuts the query of an absolute URL whose scheme is upper case', () => {
    expect(scrub('fetch HTTPS://makomarket.xyz/api/x?token=abc failed')).toBe('fetch HTTPS://makomarket.xyz/api/x failed');
  });

  // src/lib/sentry-options.ts:13-14 "email and 0x addresses masked in every string"; :86-89 says the `dsn` skip exists
  // for "the envelope header's `dsn`". INTERNAL_KEYS is checked at every depth, so any `dsn` field anywhere is skipped.
  it('still masks an email under a `dsn` key that is not the envelope header', () => {
    const event = { extra: { dsn: 'postgres://josh@example.com:5432/db' } };
    scrubDeep(event);
    expect(event.extra.dsn).not.toContain('josh@example.com');
  });
});
