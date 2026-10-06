// Adversary pass on 8b376df (spec 6: masking never drops or corrupts a legitimate event; spec 5: the /monitoring
// tunnel). Real @sentry/nextjs 11.4.0 server SDK with the production options from sentryBaseOptions(), a capturing
// transport, and the `tunnel` option set the way @sentry/nextjs sets it in the browser once withSentryConfig has a
// tunnelRoute. One Sentry.init per file.
//
// The DSN below has the shape of a real Sentry SaaS DSN (32 hex public key, `o<org>.ingest.<region>.sentry.io`, numeric
// project), which is what applyTunnelRouteOption requires before it tunnels at all. The key is not a real one.
//
// SDK behaviour relied on (paths under node_modules/.pnpm/@sentry+*@11.4.0*/node_modules/@sentry/):
//   nextjs/build/esm/client/tunnelRoute.js:12-21   with tunnelRoute set, the browser client's `tunnel` becomes
//       `/monitoring?o=<org>&p=<project>&r=<region>`, only for a DSN host matching o<digits>.ingest(.<xx>)?.sentry.io.
//   nextjs/build/esm/config/withSentryConfig/tunnel.js:20-21  /monitoring is rewritten to
//       https://o:orgid.ingest.:region.sentry.io/api/:projectid/envelope/?hsts=0, with no sentry_key in the URL.
//   core/build/esm/api.js:24-25                    with a tunnel, the transport URL is the tunnel itself, so no auth
//       query is added either.
//   core/build/esm/utils/envelope.js:143, core/build/esm/envelope.js:28, core/build/esm/tracing/spans/envelope.js:15
//       with a tunnel, every event, session and span envelope header carries `dsn: dsnToString(dsn)`. That header is
//       the only place the tunnelled request names its project key, so Sentry authenticates the envelope from it.
//   core/build/esm/client.js:411-412               beforeEnvelope fires on the envelope object the transport then sends.
import * as Sentry from '@sentry/nextjs';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { sentryBaseOptions } from '@/lib/sentry-options';

const DSN = 'https://0123456789abcdef0123456789abcdef@o4508000000000000.ingest.us.sentry.io/4508000000000001';
const headers: Record<string, unknown>[] = [];

beforeAll(() => {
  vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', DSN);
  Sentry.init({
    ...sentryBaseOptions(),
    sampleRate: 1,
    tunnel: '/monitoring?o=4508000000000000&p=4508000000000001&r=us',
    transport: () => ({
      send: async (envelope: unknown) => {
        headers.push(JSON.parse(JSON.stringify((envelope as [Record<string, unknown>])[0])));
        return {};
      },
      flush: async () => true,
    }),
  } as Parameters<typeof Sentry.init>[0]);
});

describe('spec 6: a tunnelled envelope keeps the DSN Sentry authenticates it with', () => {
  it('the envelope header `dsn` reaches the transport unchanged', async () => {
    Sentry.captureException(new Error('tunnelled error'));
    await Sentry.flush(2000);
    expect(headers.length).toBeGreaterThan(0); // the event was sent, so the next line is about its header
    expect(headers[0].dsn).toBe(DSN);
  });
});
