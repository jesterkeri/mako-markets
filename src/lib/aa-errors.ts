// ----------------------------------------------------------------------------
// src/lib/aa-errors.ts
//
// `summarizeAaError(e)` — sanitizes any error thrown by Pimlico, viem, or the
// SafeOp signing path before it crosses into a client response or a log
// line. Strips:
//   - the Pimlico API key (the URL is `…?apikey=pim_xxx`)
//   - the full bundler/paymaster URL (which contains the key)
//   - raw JSON-RPC request bodies (can include the userOp + signature)
//
// Maps known Pimlico/EntryPoint error shapes to short user-safe strings so
// the dev surface and `/api/aa/sponsor` route can show "paymaster temporarily
// unavailable" instead of leaking "<full URL with key>: 401 unauthorized."
//
// Non-throwing on purpose: every code path returns a {code, message} pair
// even if the input is undefined, null, or some non-Error value. Callers
// shouldn't have to wrap this in their own try/catch.
// ----------------------------------------------------------------------------

export type AaErrorCode =
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'CHAIN_UNSUPPORTED'
  | 'PAYMASTER_EMPTY'
  | 'SIG_VALIDATION'
  | 'SIMULATION_REVERT'
  | 'NETWORK'
  | 'CAP_EXCEEDED'
  | 'NOT_ALLOWED'
  | 'IN_FLIGHT'
  | 'UNKNOWN';

export type AaErrorSummary = {
  code: AaErrorCode;
  message: string;
};

const REDACTED = '[redacted]';

/// Strip API keys, bundler/paymaster URLs, and raw request bodies from any
/// string that's about to be logged or returned to a client. Conservative —
/// anything that even smells like a Pimlico URL or an apikey query param
/// gets redacted, even if the surrounding text looks benign.
function scrub(text: string): string {
  return (
    text
      // Pimlico URL with apikey query param (covers full and partial URLs)
      .replace(/https?:\/\/[^\s"']*api\.pimlico\.io[^\s"']*/gi, REDACTED)
      // Bare `apikey=…` token in case a URL fragment slipped through
      .replace(/apikey=[a-zA-Z0-9_-]+/gi, `apikey=${REDACTED}`)
      // `pim_` prefixed Pimlico keys anywhere in the message
      .replace(/pim_[a-zA-Z0-9_-]+/g, REDACTED)
      // Raw JSON-RPC bodies. Nested objects make balanced-brace matching
      // non-regex-friendly, so be conservatively aggressive: from
      // `{"jsonrpc"` through the end of the LINE. Single-line log
      // entries get the whole body redacted regardless of trailing
      // punctuation (`, status=400`, `;` continuation, etc.); multi-line
      // logs lose only the JSON-RPC line and keep subsequent lines.
      .replace(/\{"jsonrpc"[^\n]*/gi, REDACTED)
  );
}

function userSafeMessage(code: AaErrorCode): string {
  switch (code) {
    case 'AUTH':
      return 'Sponsorship credentials are misconfigured. Reach out to support.';
    case 'RATE_LIMIT':
      return 'Too many requests right now. Try again in a moment.';
    case 'CHAIN_UNSUPPORTED':
      return 'Sponsorship is not available on this network.';
    case 'PAYMASTER_EMPTY':
      return 'Sponsorship is temporarily unavailable. Try again shortly.';
    case 'SIG_VALIDATION':
      return 'Could not verify the request signature. Please retry.';
    case 'SIMULATION_REVERT':
      return 'The transaction would fail on chain. Check the operation and try again.';
    case 'NETWORK':
      return 'A network error happened reaching the sponsor. Try again.';
    case 'CAP_EXCEEDED':
      return 'Daily sponsored-op cap reached. Try again tomorrow or fund the Safe directly.';
    case 'NOT_ALLOWED':
      return 'This operation is not allowed under the current sponsorship policy.';
    case 'IN_FLIGHT':
      return 'Another operation is already in flight for this Safe. Wait for it to settle, then retry.';
    case 'UNKNOWN':
    default:
      return 'Something went wrong submitting the operation. Try again.';
  }
}

function classify(scrubbed: string): AaErrorCode {
  const lower = scrubbed.toLowerCase();
  if (
    lower.includes('401') ||
    lower.includes('unauthorized') ||
    lower.includes('invalid api key')
  ) {
    return 'AUTH';
  }
  if (lower.includes('429') || lower.includes('rate limit')) {
    return 'RATE_LIMIT';
  }
  if (
    lower.includes('chain') &&
    (lower.includes('not supported') || lower.includes('unsupported'))
  ) {
    return 'CHAIN_UNSUPPORTED';
  }
  if (
    lower.includes('paymaster') &&
    (lower.includes('balance') ||
      lower.includes('funds') ||
      lower.includes('deposit'))
  ) {
    return 'PAYMASTER_EMPTY';
  }
  // AA21 = "didn't pay prefund" — usually means missing/empty sponsorship,
  // but can also mean broken sender/paymaster/gas plumbing. Only attribute
  // to PAYMASTER_EMPTY when the message specifically mentions paymaster /
  // deposit / funds; otherwise route to SIMULATION_REVERT below so we don't
  // mislead the user when the real cause is a code bug.
  if (
    lower.includes('aa21') &&
    (lower.includes('paymaster') ||
      lower.includes('deposit') ||
      lower.includes('funds'))
  ) {
    return 'PAYMASTER_EMPTY';
  }
  if (lower.includes('aa24') || lower.includes('signature error')) {
    return 'SIG_VALIDATION';
  }
  if (/aa\d+/.test(lower) || lower.includes('reverted')) {
    return 'SIMULATION_REVERT';
  }
  if (
    lower.includes('econn') ||
    lower.includes('etimedout') ||
    lower.includes('fetch failed') ||
    lower.includes('network')
  ) {
    return 'NETWORK';
  }
  return 'UNKNOWN';
}

/**
 * Summarize any thrown value into a {code, message} pair safe to surface
 * to a client or write to a log line. Never throws.
 *
 * `message` is the short user-safe string keyed off `code`. The original
 * error detail is intentionally NOT included in the returned message — keep
 * verbose bundler error bodies out of client responses. Server-side, log the
 * scrubbed full text via `summarizeAaError(e).code` plus a separate
 * structured log entry if more detail is needed.
 */
export function summarizeAaError(e: unknown): AaErrorSummary {
  const { code, message } = summarizeAaErrorWithCause(e);
  // Strip `scrubbedDetail` at runtime so JSON.stringify on the result
  // can't accidentally leak server-side detail to the browser.
  return { code, message };
}

/**
 * Server-side variant of `summarizeAaError` that ALSO returns the scrubbed
 * full error text. Use this when writing a server log line where you want
 * both the short user-facing summary AND the underlying detail (with the
 * Pimlico API key + URL stripped). Never includes the raw thrown value
 * verbatim — the `scrubbedDetail` field has already passed through `scrub()`.
 *
 * Do NOT return `scrubbedDetail` to the browser. Use it for `console.error`,
 * structured log lines, and ambiguous-op runbook output.
 *
 * Never throws. Same input semantics as `summarizeAaError`.
 */
export function summarizeAaErrorWithCause(e: unknown): AaErrorSummary & {
  scrubbedDetail: string;
} {
  let raw: string;
  try {
    if (e instanceof Error) {
      raw = serializeError(e);
    } else if (typeof e === 'string') {
      raw = e;
    } else if (e && typeof e === 'object') {
      raw = safeStringify(e);
    } else {
      raw = String(e);
    }
  } catch {
    raw = '';
  }
  const scrubbed = scrub(raw);
  const code = classify(scrubbed);
  return {
    code,
    message: userSafeMessage(code),
    scrubbedDetail: scrubbed,
  };
}

/// Serialize an Error including its `cause` chain and own enumerable
/// fields (e.g. JsonRpcRejectError.code/.data). The default
/// `${e.name}: ${e.message}` form drops these, which matters for AA-flow
/// errors that carry the actual AA code in `.data`. Conservative: never
/// throws, caps depth, and serializes through `safeStringify` so a
/// circular `data` field doesn't crash the log path.
function serializeError(e: Error): string {
  const parts: string[] = [`${e.name}: ${e.message}`];

  // Own enumerable fields. JsonRpcRejectError.code, .data, .method live
  // here — capturing them recovers AA codes that the bare message drops.
  try {
    const ownKeys = Object.keys(e);
    if (ownKeys.length > 0) {
      const own: Record<string, unknown> = {};
      for (const key of ownKeys) {
        own[key] = (e as unknown as Record<string, unknown>)[key];
      }
      parts.push(`fields=${safeStringify(own)}`);
    }
  } catch {
    // Field enumeration failed somehow; skip the fields slice rather
    // than throwing.
  }

  // `cause` chain. Cap to 3 hops so a malformed cyclic chain can't
  // produce unbounded output.
  let cause: unknown = (e as { cause?: unknown }).cause;
  for (let depth = 0; depth < 3 && cause !== undefined; depth++) {
    if (cause instanceof Error) {
      parts.push(`caused by ${cause.name}: ${cause.message}`);
      cause = (cause as { cause?: unknown }).cause;
    } else {
      parts.push(`caused by ${safeStringify(cause)}`);
      cause = undefined;
    }
  }

  return parts.join(' | ');
}

/// `JSON.stringify` with a circular-ref guard. Returns the empty string
/// on any failure rather than throwing — `summarizeAaError` MUST never
/// throw, so the serialization path can't either.
function safeStringify(value: unknown): string {
  try {
    const seen = new WeakSet<object>();
    return JSON.stringify(value, (_key, v) => {
      if (typeof v === 'bigint') return `${v.toString()}n`;
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v as object)) return '[circular]';
        seen.add(v as object);
      }
      return v;
    });
  } catch {
    return '';
  }
}
