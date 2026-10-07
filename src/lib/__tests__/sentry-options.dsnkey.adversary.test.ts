// Adversary pass on c81457a (spec 3: email and 0x addresses masked everywhere, on any envelope). Real @sentry/nextjs
// 11.4.0 server SDK, production options from sentryBaseOptions(), capturing transport; only sampling is changed. One
// Sentry.init per file.
//
// c81457a added `dsn` to INTERNAL_KEYS (src/lib/sentry-options.ts:91) so the envelope header's DSN is not masked. The
// walk skips that key at EVERY depth, not only in the envelope header (scrubDeep, src/lib/sentry-options.ts:122), so
// anything an event carries under a field named `dsn` (a context, an extra, a tag) is sent unmasked.
// The email and address below are made up; they stand for a user's identity in app-supplied context.
import * as Sentry from '@sentry/nextjs';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { sentryBaseOptions } from '@/lib/sentry-options';

const wire: string[] = [];

beforeAll(() => {
  vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', 'https://public@o1.ingest.sentry.io/1');
  Sentry.init({
    ...sentryBaseOptions(),
    sampleRate: 1,
    transport: () => ({
      send: async (envelope: unknown) => {
        wire.push(JSON.stringify(envelope));
        return {};
      },
      flush: async () => true,
    }),
  } as Parameters<typeof Sentry.init>[0]);
});

describe('spec 3: a field named `dsn` inside an event is still masked', () => {
  it('an email and a 0x address under extra.dsn do not reach the transport', async () => {
    Sentry.captureException(new Error('connect failed'), {
      extra: { dsn: 'postgres://alice.smith@example.com@db.internal/app?owner=0xAbCdEf0123456789aBcDeF0123456789AbCdEf01' },
    });
    await Sentry.flush(2000);
    const sent = wire.join('\n');
    expect(sent).toContain('"value":"connect failed"'); // the event was sent
    expect(sent).not.toContain('alice.smith@example.com');
    expect(sent).not.toContain('0xAbCdEf0123456789aBcDeF0123456789AbCdEf01');
  });
});
