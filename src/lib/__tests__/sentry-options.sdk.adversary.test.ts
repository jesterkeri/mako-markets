// Adversary pass on 83577d9, run against the REAL @sentry/nextjs 11.4.0 server SDK (the Node build vitest resolves)
// with the production options from sentryBaseOptions() and a capturing transport, so every assertion is on the bytes
// that would leave the process, not on a hand-built event. One Sentry.init per file: the SDK does not come back after
// Sentry.close() in the same process, so the static-lifecycle case lives in sentry-options.static.adversary.test.ts.
//
// Only sampling is changed (sampleRate and tracesSampleRate 1): it decides WHETHER an event goes, never WHAT it holds.
//
// SDK behaviour relied on (paths under node_modules/.pnpm/@sentry+*@11.4.0*/node_modules/@sentry/):
//   core/build/cjs/client.js:97                 Client forces traceLifecycle to "stream" unless it is exactly "static".
//   node/build/cjs/sdk/index.js:179-188         Node defaults traceLifecycle to "stream".
//   core/build/cjs/server-runtime-client.js:24  a "stream" client gets spanStreamingIntegration automatically.
//   core/build/cjs/utils/warnAboutIgnoredTransactionOptions.js:12  "`beforeSendTransaction` ... ignored with
//       `traceLifecycle: 'stream'` (enabled by default)".
//   core/build/cjs/tracing/spans/captureSpan.js:26-31  a streamed span passes only through beforeSendSpan (never set).
//   core/build/types/scope.d.ts:188             setTag(key, value: Primitive), and Primitive (types/misc.d.ts:51)
//       includes bigint; tags are not normalized before beforeSend.
//   core/build/esm/client.js:599-603,870-877    a throw inside beforeSend/beforeSendTransaction drops the event.
//   core/build/cjs/utils/aggregate-errors.js:36 linked causes are PREPENDED: values[0] is the deepest cause and the
//       error that was actually thrown is the LAST value.
//   core/build/cjs/integrations/dedupe.js:61-94 the SDK's own Dedupe compares every frame of every value, so it keeps
//       both errors in the last test; only the app's 10-minute key can drop the second.
import * as Sentry from '@sentry/nextjs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { sentryBaseOptions } from '@/lib/sentry-options';

const WALLET = '0x706cf4A1aaaaaaaaaaaaaaaaaaaaaaaaaab6A51c';
const wire: string[] = [];

beforeAll(() => {
  vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', 'https://public@o1.ingest.sentry.io/1');
  vi.stubEnv('SENTRY_TRACE_LIFECYCLE', '');
  Sentry.init({
    ...sentryBaseOptions(),
    sampleRate: 1,
    tracesSampleRate: 1,
    transport: () => ({
      send: async (envelope: unknown) => {
        wire.push(JSON.stringify(envelope, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));
        return {};
      },
      flush: async () => true,
    }),
  } as Parameters<typeof Sentry.init>[0]);
});

beforeEach(() => {
  wire.length = 0;
});

describe('spec 3: a sampled span leaves masked and query-free (default streamed path)', () => {
  it('a server span naming a wallet and carrying a query string reaches the transport masked', async () => {
    // The request the existing adversary test models: use-address-names.ts fetching /api/names?addresses=<0x...>.
    Sentry.startSpan(
      {
        name: `GET /api/names?addresses=${WALLET}`,
        op: 'http.client',
        attributes: { 'url.full': `https://makomarket.xyz/api/names?addresses=${WALLET}&ref=x-post-7` },
      },
      () => undefined,
    );
    await Sentry.flush(2000);
    const sent = wire.join('\n');
    expect(sent).toContain('api/names'); // the span was sent, so the next two lines are about its content
    expect(sent).not.toContain(WALLET);
    expect(sent).not.toContain('ref=x-post-7');
  });
});

describe('spec 6: masking never throws and never loses an error event', () => {
  it('an error whose scope carries a bigint tag (setTag accepts bigint) is still sent', async () => {
    Sentry.withScope((scope) => {
      scope.setTag('stake', 10n); // a viem amount: every on-chain value in this app is a bigint
      Sentry.captureException(new Error('bet failed'));
    });
    await Sentry.flush(2000);
    expect(wire.join('\n')).toContain('"value":"bet failed"');
  });
});

describe('spec 4: only the SAME error is deduplicated', () => {
  it('two different thrown errors that share a root cause are both sent', async () => {
    // One helper, one frame, one message: how a shared RPC or fetch wrapper fails for every caller.
    const rpcFailure = () => new TypeError('fetch failed');
    Sentry.captureException(new Error('loading market 84 failed', { cause: rpcFailure() }));
    Sentry.captureException(new Error('placing the bet failed', { cause: rpcFailure() }));
    await Sentry.flush(2000);
    const sent = wire.join('\n');
    // Matched as exception values: ContextLines copies this file's source text into every event, so a bare substring
    // would also be found in the FIRST event's context lines.
    expect(sent).toContain('"value":"loading market 84 failed"');
    expect(sent).toContain('"value":"placing the bet failed"');
  });
});
