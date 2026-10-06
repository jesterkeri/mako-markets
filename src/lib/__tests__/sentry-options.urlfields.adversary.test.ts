// Adversary pass on 8b376df (spec 3: no query string or fragment on any URL or URL-derived name, on any envelope).
// Real @sentry/nextjs 11.4.0 server SDK, production options from sentryBaseOptions(), capturing transport; only
// sampling is changed (it decides WHETHER something is sent, never WHAT it holds). One Sentry.init per file.
//
// The masking layer cuts the query only under the keys in URL_KEYS (src/lib/sentry-options.ts:64). These two tests
// put a URL or URL-derived name under a key the SDK itself writes and that set does not list.
//
// SDK behaviour relied on (paths under node_modules/.pnpm/@sentry+*@11.4.0*/node_modules/@sentry/):
//   core/build/esm/client.js:95   traceLifecycle is "stream" unless set to "static", so spans go out one by one.
//   A streamed span carries its root span's name again as the attribute `sentry.segment.name` (seen on the wire by
//       this test; the same value the layer already cuts under `name`).
//   browser/build/npm/esm/prod/integrations/globalhandlers.js:101-113  a window error event gets a frame whose
//       `filename` is the script URL, or location.href when there is none, query included.
//   nextjs/build/esm/client/clientNormalizationIntegration.js:35-37    the Next client only swaps the origin for
//       `app://`, so the path and query of that filename are kept.
//   The Node stack parser reads the same V8 frame format Chrome prints (`at fn (url:line:col)`), so an Error whose
//       stack names a page URL gets that URL as `filename`, which is how a frame from an inline page script looks.
import * as Sentry from '@sentry/nextjs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { sentryBaseOptions } from '@/lib/sentry-options';

const wire: string[] = [];

beforeAll(() => {
  vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', 'https://public@o1.ingest.sentry.io/1');
  Sentry.init({
    ...sentryBaseOptions(),
    sampleRate: 1,
    tracesSampleRate: 1,
    transport: () => ({
      send: async (envelope: unknown) => {
        wire.push(JSON.stringify(envelope));
        return {};
      },
      flush: async () => true,
    }),
  } as Parameters<typeof Sentry.init>[0]);
});

beforeEach(() => {
  wire.length = 0;
});

describe('spec 3: a streamed span carries no query string under any key', () => {
  it('the root span name with a query is cut in `name` and must be cut in `sentry.segment.name` too', async () => {
    // The span shape the existing adversary test uses (sentry-options.sdk.adversary.test.ts), with a campaign query.
    Sentry.startSpan({ name: 'GET /market/84?ref=x-post-7#comments', op: 'http.server' }, () => undefined);
    await Sentry.flush(2000);
    const sent = wire.join('\n');
    expect(sent).toContain('"name":"GET /market/84"'); // the span was sent and its name was cut
    expect(sent).not.toContain('ref=x-post-7');
    expect(sent).not.toContain('#comments');
  });
});

describe('spec 3: an error event carries no query string under any key', () => {
  it('a stack frame whose filename is a page URL loses its query', async () => {
    const err = new Error('inline script failed');
    err.stack = 'Error: inline script failed\n    at boot (https://makomarket.xyz/market/84?ref=x-post-7:12:5)';
    Sentry.captureException(err);
    await Sentry.flush(2000);
    const sent = wire.join('\n');
    expect(sent).toContain('"value":"inline script failed"'); // the event was sent
    expect(sent).not.toContain('ref=x-post-7');
  });
});
