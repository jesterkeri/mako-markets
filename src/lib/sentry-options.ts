// ----------------------------------------------------------------------------
// src/lib/sentry-options.ts
//
// Shared Sentry settings for the browser, Node and Edge runtimes (mako-design NONFUNCTIONAL_GATE.md O1; Joshua's rule
// 2026-09-17: every shipped build gets error monitoring, with a quota guard and no personal data).
//
// Quota guard: the free Developer plan is 5,000 errors a month, and the app polls every few seconds, so one tab on a
// failing endpoint could spend the month in a day. So: only a share of errors is sent, a repeat of the same error is
// dropped for a while, wallet-extension noise is ignored, and almost no performance tracing.
// Privacy: sendDefaultPii off, no user on any event, request cookies and headers dropped, email addresses and 0x
// addresses masked in messages, exception values and breadcrumbs. Session Replay is never enabled.
// Off entirely while NEXT_PUBLIC_SENTRY_DSN is unset.
// ----------------------------------------------------------------------------

import type { ErrorEvent, EventHint } from '@sentry/nextjs';

/// Errors that are not Mako Market's: wallets and extensions refusing, and well-known browser noise.
export const IGNORE_ERRORS: (string | RegExp)[] = [
  /user rejected/i,
  /user denied/i,
  /MFA canceled/i,
  /MetaMask/i,
  /Phantom/i,
  /chrome-extension:\/\//,
  /moz-extension:\/\//,
  /ResizeObserver loop/,
  /Non-Error promise rejection captured/,
  /Load failed$/,
  /NetworkError when attempting to fetch resource/,
];

/// A share of errors, and almost no tracing: enough to see what breaks, within the free plan.
export const ERROR_SAMPLE_RATE = 0.5;
export const TRACES_SAMPLE_RATE = 0.01;
/// The same error (type, message, first frame) is sent at most once per window from one browser or server instance.
export const DEDUPE_WINDOW_MS = 10 * 60 * 1000;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const HEX_ADDRESS = /0x[0-9a-fA-F]{40}\b/g;

/// Masks email addresses and 0x addresses in a string: identities are not Sentry's to keep.
export function scrub(text: string): string {
  return text.replace(EMAIL, '[email]').replace(HEX_ADDRESS, '0x[address]');
}

function fingerprint(event: ErrorEvent): string {
  const ex = event.exception?.values?.[0];
  const frame = ex?.stacktrace?.frames?.at(-1);
  return [ex?.type ?? '', ex?.value ?? event.message ?? '', frame?.filename ?? '', frame?.function ?? ''].join('|');
}

/// beforeSend for every runtime: drop repeats within the window, then strip identity from what remains.
export function makeBeforeSend(now: () => number = Date.now) {
  const seen = new Map<string, number>();
  return function beforeSend(event: ErrorEvent, _hint?: EventHint): ErrorEvent | null {
    void _hint;
    const key = fingerprint(event);
    const t = now();
    const last = seen.get(key);
    if (last !== undefined && t - last < DEDUPE_WINDOW_MS) return null;
    seen.set(key, t);
    if (seen.size > 500) seen.delete(seen.keys().next().value as string);

    delete event.user;
    if (event.request) {
      delete event.request.cookies;
      delete event.request.headers;
      delete event.request.data;
      if (event.request.query_string) event.request.query_string = '[removed]';
      if (event.request.url) event.request.url = scrub(event.request.url);
    }
    if (event.message) event.message = scrub(event.message);
    for (const ex of event.exception?.values ?? []) if (ex.value) ex.value = scrub(ex.value);
    for (const b of event.breadcrumbs ?? []) {
      if (b.message) b.message = scrub(b.message);
      if (b.data) b.data = JSON.parse(scrub(JSON.stringify(b.data))) as typeof b.data;
    }
    return event;
  };
}

/// The options every runtime shares. `dsn` is public by design (it only lets a client send events).
export function sentryBaseOptions() {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN?.trim() || undefined;
  return {
    dsn,
    enabled: !!dsn,
    environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.VERCEL_ENV ?? 'development',
    sampleRate: ERROR_SAMPLE_RATE,
    tracesSampleRate: TRACES_SAMPLE_RATE,
    sendDefaultPii: false,
    ignoreErrors: IGNORE_ERRORS,
    beforeSend: makeBeforeSend(),
  };
}
