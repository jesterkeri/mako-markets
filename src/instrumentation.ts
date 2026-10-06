// Sentry on the server (Node.js and Edge runtimes), with the same quota guard and privacy rules as the browser
// (src/lib/sentry-options.ts). Off while NEXT_PUBLIC_SENTRY_DSN is unset. onRequestError reports errors thrown while
// rendering or in route handlers.
import * as Sentry from '@sentry/nextjs';

import { sentryBaseOptions } from '@/lib/sentry-options';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs' || process.env.NEXT_RUNTIME === 'edge') {
    Sentry.init(sentryBaseOptions());
  }
}

export const onRequestError = Sentry.captureRequestError;
