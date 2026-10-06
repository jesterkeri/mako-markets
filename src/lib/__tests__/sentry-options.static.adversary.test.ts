// Adversary pass on 83577d9 (spec 6: an exception inside beforeSendTransaction loses the event). beforeSendTransaction
// only runs with traceLifecycle "static" (the default "stream" skips it, see sentry-options.sdk.adversary.test.ts), so
// this file turns "static" on, as the SDK's own warning tells you to, and sends one real Node transaction through the
// production hook. Real @sentry/nextjs 11.4.0 server SDK, capturing transport, tracesSampleRate 1 only for determinism.
//
// SDK behaviour relied on (paths under node_modules/.pnpm/@sentry+*@11.4.0*/node_modules/@sentry/):
//   core/build/esm/tracing/sentrySpan.js:325-327  the transaction carries the live Scope objects in
//       sdkProcessingMetadata.capturedSpanScope / capturedSpanIsolationScope; a Scope holds its client (scope.js:70).
//   node/build/esm/sdk/client.js:118              the Node client holds a setInterval Timeout, a circular structure.
//   core/build/esm/client.js:870-877              a throw inside beforeSendTransaction drops the event
//       (outcome "callback_error").
import * as Sentry from '@sentry/nextjs';
import { describe, expect, it, vi } from 'vitest';

import { sentryBaseOptions } from '@/lib/sentry-options';

const WALLET = '0x706cf4A1aaaaaaaaaaaaaaaaaaaaaaaaaab6A51c';

describe('spec 6: beforeSendTransaction never throws on a real transaction', () => {
  it('a Node transaction reaches the transport, masked', async () => {
    vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', 'https://public@o1.ingest.sentry.io/1');
    const wire: string[] = [];
    Sentry.init({
      ...sentryBaseOptions(),
      tracesSampleRate: 1,
      traceLifecycle: 'static',
      transport: () => ({
        send: async (envelope: unknown) => {
          wire.push(JSON.stringify(envelope));
          return {};
        },
        flush: async () => true,
      }),
    } as Parameters<typeof Sentry.init>[0]);
    Sentry.startSpan({ name: `GET /api/names?addresses=${WALLET}`, op: 'http.server' }, () => undefined);
    await Sentry.flush(2000);
    const sent = wire.join('\n');
    expect(sent).toContain('"type":"transaction"');
    expect(sent).not.toContain(WALLET);
    vi.unstubAllEnvs();
  });
});
