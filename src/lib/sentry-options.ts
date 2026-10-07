// ----------------------------------------------------------------------------
// src/lib/sentry-options.ts
//
// Shared Sentry settings for the browser, Node and Edge runtimes (mako-design NONFUNCTIONAL_GATE.md O1; Joshua's rule
// 2026-09-17: every shipped build gets error monitoring, with a quota guard and no personal data).
//
// Quota guard: the free Developer plan is 5,000 errors a month, and the app polls every few seconds, so one tab on a
// failing endpoint could spend the month in a day. So: only a share of errors is sent, a repeat of the same error is
// dropped for a while, wallet-extension noise is ignored, and almost no performance tracing.
//
// Privacy: sendDefaultPii off and Session Replay never enabled. Then two layers:
//   1. beforeSend / beforeSendTransaction drop the user, request cookies, headers, body and query from the event.
//   2. Every envelope, just before it is handed to the transport, is walked once: email and 0x addresses masked in
//      every string, the query string and fragment cut from every URL-bearing field, and user and header attributes
//      deleted. This is the layer that cannot be skipped: SDK 11.4.0 streams spans by default, and a streamed span
//      passes through neither beforeSend nor beforeSendTransaction (adversary on 83577d9), but it is still sent as an
//      envelope, and so are the envelope headers that carry a transaction name.
// The walk never serializes: it skips the SDK's internal metadata, cycles and anything that is not plain data, so it
// cannot throw on a live Scope or a bigint and lose the event with it.
// Off entirely while NEXT_PUBLIC_SENTRY_DSN is unset.
// ----------------------------------------------------------------------------

import type { ErrorEvent, Event, EventHint } from '@sentry/nextjs';

/// The two SDK shapes the envelope layer needs, declared by structure: their own types live in @sentry/core, which
/// @sentry/nextjs does not re-export and this app does not depend on directly.
type EnvelopeHookClient = { on(hook: 'beforeEnvelope', callback: (envelope: unknown) => void): unknown };
type ScrubIntegration = { name: string; setup(client: EnvelopeHookClient): void };

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
/// The same error (its whole cause chain, masked, and the thrown error's top frame) is sent at most once per window
/// from one browser or server instance.
export const DEDUPE_WINDOW_MS = 10 * 60 * 1000;

// Bounded quantifiers keep the scan linear: an unbounded `[...]+` before a required `@` backtracks over the whole run
// at every start, and a 100,000-character hex blob took six seconds (adversary on 83577d9). 64 and 253 are the longest
// local part and domain an email can have. `%40` is an encoded `@`, as an email sits in a URL.
const EMAIL = /[A-Za-z0-9._%+-]{1,64}(?:@|%40)[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}/gi;
// The lookarounds stop an address inside a longer hex string (a transaction hash) from matching, and still match one
// followed by `_` or a letter.
const HEX_ADDRESS = /(?<![0-9a-fA-F])0[xX][0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
/// An absolute URL inside free text (an exception message, a console breadcrumb): its query and fragment are cut.
/// The query part is optional so a URL with none matches at once: a required `[?#]` after an unbounded run backtracked
/// over the run at every `http://` start, quadratic (adversary r4 on c81457a).
const URL_QUERY_IN_TEXT = /(\bhttps?:\/\/[^\s?#"'<>]+)(?:[?#][^\s"'<>]*)?/g;
/// A query string or fragment inside a longer string, such as a span name `GET /api/names?addresses=...`.
const QUERY_IN_TEXT = /[?#][^\s"]*/g;
/// Fields that hold a URL or a name built from one: their query string and fragment are cut. Covers events (request
/// url, breadcrumb url/from/to, transaction), streamed spans (name, url.full, http.url) and the envelope header's
/// transaction name.
const URL_KEYS = new Set([
  'url',
  'from',
  'to',
  'http.url',
  'url.full',
  'http.target',
  'url.path',
  'transaction',
  'name',
  'description',
  // A streamed span repeats its root span's name here (adversary r3 on 8b376df).
  'sentry.segment.name',
  // A stack frame named by a page URL (inline or eval'd script): its filename, absolute path and derived module.
  'filename',
  'abs_path',
  'module',
  // The SDK builds a debug-ID image's code_file from the same frame filename; both must be cut alike or the frame stops
  // naming its source-map image (adversary r4 on c81457a: `?dpl=` chunk URLs under app:///).
  'code_file',
  'debug_file',
]);
/// Fields deleted wherever they appear: a query by itself, the user, and header attributes.
const DROP_KEY = /^(?:user|user_agent|http\.query|http\.fragment|url\.query|url\.fragment|user\..*|http\.request\.header\..*|http\.response\.header\..*)$/;
/// Never walked: the SDK's in-process bookkeeping on an event (live Scopes, a client holding a timer).
const INTERNAL_KEYS = new Set(['sdkProcessingMetadata']);

/// Masks email addresses and 0x addresses in a string: identities are not Sentry's to keep.
export function scrub(text: string): string {
  return text.replace(URL_QUERY_IN_TEXT, '$1').replace(EMAIL, '[email]').replace(HEX_ADDRESS, '0x[address]');
}

/// A URL without its query string or fragment, then masked. Campaign links and API calls carry identity in the query.
export function scrubUrl(url: string): string {
  return scrub(url.replace(QUERY_IN_TEXT, ''));
}

function isPlain(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/// Masks a whole value in place: every string scrubbed, URL fields cut at the query, dropped keys deleted. Only plain
/// objects and arrays are entered (a typed array, a Date, a Scope or a client is left as it is), each at most once.
/// `key` is the field the value sits in; a span attribute `{ "url.full": { value: "..." } }` passes its own key down.
export function scrubDeep(value: unknown, key = '', seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') return URL_KEYS.has(key) ? scrubUrl(value) : scrub(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) return value;
    seen.add(value);
    for (let i = 0; i < value.length; i++) value[i] = scrubDeep(value[i], key, seen);
    return value;
  }
  if (!isPlain(value)) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const k of Object.keys(value)) {
    if (INTERNAL_KEYS.has(k)) continue;
    if (DROP_KEY.test(k)) {
      delete value[k];
      continue;
    }
    value[k] = scrubDeep(value[k], k === 'value' ? key : k, seen);
  }
  return value;
}

/// The identity an event carries by design: removed outright rather than masked.
function stripRequest<E extends Event>(event: E): E {
  delete event.user;
  if (event.request) {
    delete event.request.cookies;
    delete event.request.headers;
    delete event.request.data;
    if (event.request.query_string) event.request.query_string = '[removed]';
  }
  return event;
}

/// The error as Sentry will show it: every value in the cause chain (the SDK puts the deepest cause first and the
/// thrown error last), masked, plus the thrown error's top frame. Two errors that only share a cause differ here.
function fingerprint(event: ErrorEvent): string {
  const values = event.exception?.values ?? [];
  const thrown = values.at(-1);
  const frame = thrown?.stacktrace?.frames?.at(-1);
  const chain = values.map((v) => `${v.type ?? ''}:${scrub(v.value ?? '')}`).join('>');
  return [chain || scrub(event.message ?? ''), frame?.filename ?? '', frame?.function ?? ''].join('|');
}

/// beforeSend for every runtime: strip the request identity, mask the event, then drop a repeat within the window.
/// The key is taken after masking, so one failure hit by many wallets is one error, not one per wallet.
export function makeBeforeSend(now: () => number = Date.now) {
  const seen = new Map<string, number>();
  return function beforeSend(event: ErrorEvent, _hint?: EventHint): ErrorEvent | null {
    void _hint;
    scrubDeep(stripRequest(event));
    const key = fingerprint(event);
    const t = now();
    const last = seen.get(key);
    if (last !== undefined && t - last < DEDUPE_WINDOW_MS) return null;
    seen.set(key, t);
    if (seen.size > 500) seen.delete(seen.keys().next().value as string);
    return event;
  };
}

/// beforeSendTransaction (traceLifecycle "static" only): the same stripping and masking as an error.
export function beforeSendTransaction<E extends Event>(event: E): E {
  scrubDeep(stripRequest(event));
  return event;
}

/// The layer that sees everything sent: each envelope, headers and items, masked just before the transport.
export function scrubEnvelopes(): ScrubIntegration {
  return {
    name: 'MakoScrubEnvelopes',
    setup(client) {
      client.on('beforeEnvelope', (envelope) => {
        // The envelope HEADER's dsn is the one value left whole. Behind the /monitoring tunnel it is the only thing that
        // tells Sentry which key and project an envelope is for, and its `<public key>@o<org>.ingest...` form looks like
        // an email: masking it made every browser report unauthenticatable (adversary r3 on 8b376df). It carries the
        // public key only, public by design. A `dsn` anywhere else is masked like any field (adversary r4).
        const header = Array.isArray(envelope) ? (envelope[0] as Record<string, unknown> | undefined) : undefined;
        const dsn = header && typeof header.dsn === 'string' ? header.dsn : undefined;
        scrubDeep(envelope);
        if (header && dsn !== undefined) header.dsn = dsn;
      });
    },
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
    beforeSendTransaction,
    integrations: <I>(defaults: I[]): (I | ScrubIntegration)[] => [...defaults, scrubEnvelopes()],
  };
}
