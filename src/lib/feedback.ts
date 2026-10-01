// Feedback (GTM plan §1): a tester types a message, the server forwards it to Joshua's Telegram as plain text with
// the page it came from, the account (if signed in), the ref tag and the browser family. These helpers are shared by
// the route and the sheet, so both count characters the same way. Nothing here touches a secret.

export const FEEDBACK_MAX_CHARS = 1000;
/// Signed-in senders: per account, per clock hour.
export const FEEDBACK_PER_ACCOUNT_PER_HOUR = 5;
/// Signed-out senders: ONE shared bucket for all of them together, per clock hour (no IP address is stored).
export const FEEDBACK_ANON_PER_HOUR = 30;
/// A body larger than this is refused before it is parsed (the message itself is capped at 1,000 characters).
export const FEEDBACK_MAX_BODY_BYTES = 16 * 1024;
const PATH_MAX = 200;

/// Control characters other than newline and tab, and the bidirectional overrides that can make text read in a
/// different order than it is stored. They are removed from a message before it is counted or sent.
const STRIP = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

export function cleanMessage(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').replace(STRIP, '').trim();
}

/// Characters as a reader counts them (code points, so an emoji is one), after cleaning and trimming.
export function messageLength(raw: string): number {
  return Array.from(cleanMessage(raw)).length;
}

export type FeedbackBody = { message: string; path: string };
export type FeedbackBodyError = 'bad_body' | 'unknown_field' | 'bad_message' | 'empty_message' | 'message_too_long' | 'bad_path';

/// Strict: an object with exactly `message` and `path`, both strings. `path` is the page's own path (starts with a
/// single "/", at most 200 characters, no spaces or control characters). Unknown keys are refused, not ignored.
export function parseFeedbackBody(raw: unknown): { ok: true; body: FeedbackBody } | { ok: false; error: FeedbackBodyError } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'bad_body' };
  const keys = Object.keys(raw);
  if (keys.some((k) => k !== 'message' && k !== 'path')) return { ok: false, error: 'unknown_field' };
  const { message, path } = raw as Record<string, unknown>;
  if (typeof message !== 'string') return { ok: false, error: 'bad_message' };
  if (typeof path !== 'string' || !/^\/(?!\/)[^\s\u0000-\u001f\u007f]{0,199}$/.test(path) || path.length > PATH_MAX) {
    return { ok: false, error: 'bad_path' };
  }
  const cleaned = cleanMessage(message);
  const n = Array.from(cleaned).length;
  if (n === 0) return { ok: false, error: 'empty_message' };
  if (n > FEEDBACK_MAX_CHARS) return { ok: false, error: 'message_too_long' };
  return { ok: true, body: { message: cleaned, path } };
}

/// A short browser family from a User-Agent string; never the string itself.
export function browserFamily(ua: string | null): string {
  if (!ua) return 'Unknown';
  if (/\bEdg(e|A|iOS)?\//.test(ua)) return 'Edge';
  if (/\bOPR\/|\bOpera\b/.test(ua)) return 'Opera';
  if (/\bSamsungBrowser\//.test(ua)) return 'Samsung Internet';
  if (/\bFirefox\/|\bFxiOS\//.test(ua)) return 'Firefox';
  if (/\bCriOS\/|\bChrome\//.test(ua)) return 'Chrome';
  if (/\bSafari\//.test(ua) && /\bVersion\//.test(ua)) return 'Safari';
  return 'Other';
}

export type FeedbackMeta = {
  path: string;
  /// The account's address (the Mako wallet for email accounts, the wallet itself for wallet accounts), or null.
  account: { address: string; kind: 'email' | 'wallet' } | null;
  ref: string | null;
  browser: string;
};

/// The Telegram message: a fixed header the server writes, then the tester's words, last, so nothing they type can
/// sit where the header's fields are. Sent with no parse mode, so it is shown exactly as written.
export function composeFeedbackText(message: string, meta: FeedbackMeta): string {
  return [
    'Mako Market feedback',
    `Page: ${meta.path}`,
    `Account: ${meta.account ? `${meta.account.address} (${meta.account.kind})` : 'signed out'}`,
    `Ref: ${meta.ref ?? 'none'}`,
    `Browser: ${meta.browser}`,
    '',
    message,
  ].join('\n');
}
