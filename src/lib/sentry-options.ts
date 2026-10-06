// ----------------------------------------------------------------------------
// src/lib/sentry-options.ts
//
// Shared Sentry settings for the browser, Node and Edge runtimes (mako-design NONFUNCTIONAL_GATE.md O1; Joshua's rule
// 2026-09-17: every shipped build gets error monitoring, with a quota guard and no personal data).
//
// Quota guard: the free Developer plan is 5,000 errors a month, and the app polls every few seconds, so one tab on a
// failing endpoint could spend the month in a day. So: only a share of errors is sent, a repeat of the same error is
// dropped for a while, wallet-extension noise is ignored, and almost no performance tracing.
// Privacy: sendDefaultPii off, no user on any event, request cookies, headers, body and query dropped, no query string
// or fragment on any URL (request, breadcrumbs, spans), and email and 0x addresses masked everywhere in errors and
// transactions alike. Session Replay is never enabled.
// Off entirely while NEXT_PUBLIC_SENTRY_DSN is unset.
// ----------------------------------------------------------------------------

import type { ErrorEvent, Event, EventHint } from '@sentry/nextjs';

/// Sentry's own type for the transaction a beforeSendTransaction hook receives (not re-exported by @sentry/nextjs).
type TransactionEvent = Event & { type: 'transaction' };

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

// `%40` is an encoded `@`, as an email sits in a URL. The lookarounds stop an address inside a longer hex string (a
// transaction hash) from matching, and still match one followed by `_` or a letter.
const EMAIL = /[A-Za-z0-9._%+-]+(?:@|%40)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gi;
const HEX_ADDRESS = /(?<![0-9a-fA-F])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
/// A query string or fragment inside a longer string, such as a span description `GET /api/names?addresses=...`.
const QUERY_IN_TEXT = /[?#][^\s"]*/g;
/// Breadcrumb and span fields that hold a URL (fetch, xhr, navigation).
const URL_KEYS = new Set(['url', 'from', 'to', 'http.url', 'url.full']);
const QUERY_KEYS = ['http.query', 'http.fragment', 'url.query'];

/// Masks email addresses and 0x addresses in a string: identities are not Sentry's to keep.
export function scrub(text: string): string {
  return text.replace(EMAIL, '[email]').replace(HEX_ADDRESS, '0x[address]');
}

/// A URL without its query string or fragment, then masked. Campaign links and API calls carry identity in the query.
export function scrubUrl(url: string): string {
  return scrub(url.replace(QUERY_IN_TEXT, ''));
}

type Data = Record<string, unknown>;

function cleanUrlFields(data: Data | undefined): void {
  if (!data) return;
  for (const k of Object.keys(data)) if (URL_KEYS.has(k) && typeof data[k] === 'string') data[k] = scrubUrl(data[k] as string);
  for (const k of QUERY_KEYS) delete data[k];
}

/// Strips identity from any event, error or transaction: no user, no cookies, headers, body or query, no query on any
/// URL, and every email and 0x address masked wherever it appears. Returns a new event.
function clean<E extends Event>(event: E): E {
  delete event.user;
  if (event.request) {
    delete event.request.cookies;
    delete event.request.headers;
    delete event.request.data;
    if (event.request.query_string) event.request.query_string = '[removed]';
    if (event.request.url) event.request.url = scrubUrl(event.request.url);
  }
  for (const b of event.breadcrumbs ?? []) cleanUrlFields(b.data as Data | undefined);
  for (const sp of event.spans ?? []) {
    if (sp.description) sp.description = sp.description.replace(QUERY_IN_TEXT, '');
    cleanUrlFields(sp.data as Data | undefined);
  }
  const trace = event.contexts?.trace;
  if (trace) cleanUrlFields(trace.data as Data | undefined);
  if (typeof event.transaction === 'string') event.transaction = event.transaction.replace(QUERY_IN_TEXT, '');
  // Everything else (message, exception values, breadcrumb messages, span data, contexts, extra, tags): mask in place.
  return JSON.parse(scrub(JSON.stringify(event))) as E;
}

function fingerprint(event: ErrorEvent): string {
  const ex = event.exception?.values?.[0];
  const frame = ex?.stacktrace?.frames?.at(-1);
  return [ex?.type ?? '', ex?.value ?? event.message ?? '', frame?.filename ?? '', frame?.function ?? ''].join('|');
}

/// beforeSend for every runtime: strip identity, then drop a repeat within the window. The key is taken AFTER
/// masking, so one failure hit by many wallets is one error, not one per wallet.
export function makeBeforeSend(now: () => number = Date.now) {
  const seen = new Map<string, number>();
  return function beforeSend(event: ErrorEvent, _hint?: EventHint): ErrorEvent | null {
    void _hint;
    const out = clean(event);
    const key = fingerprint(out);
    const t = now();
    const last = seen.get(key);
    if (last !== undefined && t - last < DEDUPE_WINDOW_MS) return null;
    seen.set(key, t);
    if (seen.size > 500) seen.delete(seen.keys().next().value as string);
    return out;
  };
}

/// beforeSendTransaction: the sampled transactions get the same stripping (beforeSend never sees them).
export function beforeSendTransaction(event: TransactionEvent): TransactionEvent {
  return clean(event);
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
    beforeSendTransaction,
  };
}
