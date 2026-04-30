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
      // Raw JSON-RPC bodies are heuristically detected by the leading
      // {"jsonrpc"... pattern. Drop the body, keep the surrounding context.
      .replace(/\{"jsonrpc"[\s\S]*?\}(?=\s|$)/g, REDACTED)
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
  let raw: string;
  try {
    if (e instanceof Error) {
      raw = `${e.name}: ${e.message}`;
    } else if (typeof e === 'string') {
      raw = e;
    } else if (e && typeof e === 'object') {
      raw = JSON.stringify(e);
    } else {
      raw = String(e);
    }
  } catch {
    raw = '';
  }
  const scrubbed = scrub(raw);
  const code = classify(scrubbed);
  return { code, message: userSafeMessage(code) };
}
