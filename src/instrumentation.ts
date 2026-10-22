// Sentry on the server (Node.js and Edge runtimes), with the same quota guard and privacy rules as the browser
// (src/lib/sentry-options.ts). Off while NEXT_PUBLIC_SENTRY_DSN is unset. onRequestError reports errors thrown while
// rendering or in route handlers. register() also loads the Mako release guard (see below).
import * as Sentry from '@sentry/nextjs';

import { sentryBaseOptions } from '@/lib/sentry-options';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs' || process.env.NEXT_RUNTIME === 'edge') {
    Sentry.init(sentryBaseOptions());
  }
  // The root release guard (src/lib/contract.ts MAKO_RELEASE): loading contract.ts throws unless
  // NEXT_PUBLIC_MAKO_ADDRESS is a reviewed deployment, and Next does not let a server whose register() rejects take
  // any request, so a server pointed at an unreviewed contract never serves a page or a route.
  await import('@/lib/contract');
}

export const onRequestError = Sentry.captureRequestError;
