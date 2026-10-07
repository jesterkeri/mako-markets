// Adversary pass on c81457a (spec 5: masking stays linear-time). No SDK needed: scrub() is the function every string on
// every envelope goes through (src/lib/sentry-options.ts:94), and an exception value is not truncated by the SDK unless
// maxValueLength is set (@sentry/core 11.4.0 build/esm/utils/prepareEvent.js:86-91; sentryBaseOptions does not set it).
//
// c81457a added URL_QUERY_IN_TEXT (src/lib/sentry-options.ts:60). Its `[^\s?#"'<>]+` is unbounded and must be followed by
// `?` or `#`, so from every `http://` in a run with no space, quote, `?` or `#` the engine scans to the end of the run
// and backs off one character at a time: quadratic in the number of URL starts. The existing linear-time test
// (sentry-options.test.ts:34-37) uses ONE `https://` start, which is linear. Same size and bound as that test.
import { describe, expect, it } from 'vitest';

import { scrub } from '@/lib/sentry-options';

describe('spec 5: scrub stays linear-time', () => {
  it('a 100,000-character run of URL starts with no query is scrubbed in under 200 ms', () => {
    const run = 'http://'.repeat(100_000 / 7);
    const t0 = performance.now();
    scrub(run);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});
