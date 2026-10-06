// Adversary pass on the Sentry privacy and quota rules (spec for commit 2fc62ce): events are shaped the way
// @sentry/core 11.4.0 and @sentry/browser 11.4.0 build them, so each case is a path a real event takes.
//   Browser: integrations/httpcontext.js sets event.request = { url: location.href, ... }, query string included,
//            and never sets query_string.
//   Server:  utils/request.js httpRequestToRequestData sets url to the absolute request URL with its query string.
//   Client:  client.js processBeforeSend calls beforeSend only for error events; a transaction goes to
//            beforeSendTransaction / beforeSendSpan, and sampleRate is applied after beforeSend.
import type { ErrorEvent, Event } from '@sentry/nextjs';
import { describe, expect, it } from 'vitest';

import { makeBeforeSend, sentryBaseOptions } from '@/lib/sentry-options';

const WALLET = '0x706cf4A1aaaaaaaaaaaaaaaaaaaaaaaaaab6A51c';
const OTHER = '0x1111111111111111111111111111111111111111';

const errorAt = (url: string, value = 'boom'): ErrorEvent =>
  ({
    exception: { values: [{ type: 'Error', value, stacktrace: { frames: [{ filename: 'app/page.tsx', function: 'f' }] } }] },
    request: { url },
  }) as unknown as ErrorEvent;

describe('spec 3: no query string reaches Sentry', () => {
  it('a browser error on a campaign link (?ref=, RefCapture.tsx) leaves without its query string', () => {
    // Exactly what HttpContext builds in the browser: url = location.href, no query_string field at all.
    const out = makeBeforeSend(() => 0)(errorAt('https://makomarket.xyz/markets/84?ref=x-post-7&utm_campaign=launch'))!;
    expect(out.request?.url).not.toContain('?');
    expect(out.request?.url).not.toContain('ref=x-post-7');
  });

  it('a percent-encoded email in the URL is masked like any other email', () => {
    const out = makeBeforeSend(() => 0)(errorAt('https://makomarket.xyz/signin?email=joshua.test%40example.com'))!;
    expect(out.request?.url).not.toContain('joshua.test');
  });
});

describe('spec 3: no 0x address reaches Sentry on a transaction', () => {
  it('a sampled browser transaction whose fetch span carries wallet addresses is masked', () => {
    // use-address-names.ts fetches /api/names?addresses=<0x...>; the http.client span description and the
    // transaction request url carry it. beforeSend never sees a transaction (client.js processBeforeSend).
    const tx: Event = {
      type: 'transaction',
      transaction: '/markets/[id]',
      request: { url: `https://makomarket.xyz/markets/84?viewer=${WALLET}` },
      spans: [
        {
          span_id: 'a'.repeat(16),
          trace_id: 'b'.repeat(32),
          start_timestamp: 0,
          op: 'http.client',
          description: `GET /api/names?addresses=${WALLET},${OTHER}`,
          data: { url: `/api/names?addresses=${WALLET},${OTHER}` },
        },
      ],
    } as unknown as Event;
    const opts = sentryBaseOptions() as Record<string, unknown>;
    const hook = opts.beforeSendTransaction as ((e: Event, h: unknown) => Event | null) | undefined;
    const sent = hook ? hook(tx, {}) : tx; // what the SDK does: no hook, the event goes out as is
    expect(JSON.stringify(sent)).not.toContain(WALLET);
  });
});

describe('spec 4: the same error is sent at most once per 10 minutes per process', () => {
  it('two users hitting the same failure send ONE event, not one per wallet', () => {
    // After masking both events read "insufficient balance for 0x[address]" with the same type and top frame,
    // so Sentry receives the same (type, message, top frame) twice within the window.
    const send = makeBeforeSend(() => 0);
    const a = send(errorAt('https://makomarket.xyz/markets/84', `insufficient balance for ${WALLET}`));
    const b = send(errorAt('https://makomarket.xyz/markets/84', `insufficient balance for ${OTHER}`));
    expect(a?.exception?.values?.[0].value).toBe('insufficient balance for 0x[address]');
    expect(b).toBeNull();
  });
});
