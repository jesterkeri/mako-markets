// ----------------------------------------------------------------------------
// price-recorder/src/client.ts
//
// The recorder's one Data Streams call: `GET /api/v1/reports/page?feedID=F&startTimestamp=S&limit=100`
// (CHARTS_DS_PLAN 3.4, 4.1). Signing is the resolver's own code, imported, never copied (plan 3.1): reportHeaders and
// hmacSha256Hex from cf-worker/src/datastreams.ts, with the HMAC timestamp taken immediately before each request
// (plan 4.1, `crypto-datastreams.ts:159-161`), and the resolver's 8 s per-call timeout (plan 4.4).
//
// An answer is classified, never thrown, and never carries the body, the request or a header out of this file
// (plan 4.1: errors carry status, reason and request id only):
//   ok            200 with a JSON object holding a `reports` array of at most 100 entries, in a body of at most 200,000
//                 bytes; each entry keeps only the fields read, as flat values (keepRead)
//   feed_refused  401 or 403 whose body, read up to 200 bytes and parsed as JSON, has `error` exactly
//                 "feeds not authorized": a refusal of the feed requested (plan 4.1, the 2026-10-16 captures)
//   key_failure   any other 401 or 403 (another error text, no body, a body that is not JSON, an HMAC error)
//   rate_limited  429
//   failed        anything else: 5xx, another status, a 200 body that is not a page, a timeout or a network error
// ----------------------------------------------------------------------------

import { hmacSha256Hex, REPORT_TIMEOUT_MS, reportHeaders, type HmacHex, type ReportCredentials } from '../../cf-worker/src/datastreams';
import { keccak256, stringToBytes } from 'viem';

import { typed, type PageEntry } from './entry';

/// The measured maximum `limit` of /reports/page (plan 1, captures of 2026-10-16).
export const PAGE_LIMIT = 100;
/// A refusal body is classified from at most this many bytes (plan 4.1).
export const REFUSAL_BODY_BYTES = 200;
/// A page of 100 reports is about 170 KB (plan 1); anything far larger is not a page and is not read further.
/// A real page of 100 reports is about 164 KB (2026-10-16 capture: every entry 1,636 bytes); 200,000 bytes leaves about
/// 20%. With keepRead's flat values, what a tick holds of its pages stays about 330 x 200 KB = 66 MB at most, under the
/// Worker's 128 MB (plan 3.4, 4.3; adversary on r22).
export const MAX_PAGE_BYTES = 200_000;
export const FEEDS_NOT_AUTHORIZED = 'feeds not authorized';

export const pagePath = (feedId: string, start: number, limit = PAGE_LIMIT): string =>
  `/api/v1/reports/page?feedID=${feedId}&startTimestamp=${start}&limit=${limit}`;

export type PageResult =
  | { kind: 'ok'; status: 200; reports: PageEntry[]; requestId: string | null }
  | { kind: 'feed_refused' | 'key_failure' | 'rate_limited'; status: number; requestId: string | null }
  | { kind: 'failed'; status: number; reason: 'server_error' | 'bad_status' | 'bad_body' | 'network'; requestId: string | null }
  /// Not sent: the tick was halted while the request was being signed (mayStart).
  | { kind: 'unsent'; status: 0; requestId: null };

export type PageClient = (feedId: string, start: number) => Promise<PageResult>;

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/// The body as text, reading at most `max` bytes; `truncated` when the body had more.
async function readCapped(res: Response, max: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: '', truncated: false };
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = max - size;
    if (value.byteLength > room) {
      parts.push(value.subarray(0, room));
      size = max;
      truncated = true;
      break;
    }
    parts.push(value);
    size += value.byteLength;
  }
  if (truncated) await reader.cancel().catch(() => undefined);
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  return { text: new TextDecoder().decode(all), truncated };
}

/// Plan 4.1: `error` exactly "feeds not authorized" is a refusal of the feed; anything else is a whole-key failure.
export function isFeedRefusal(text: string): boolean {
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === 'object' && !Array.isArray(v) && (v as { error?: unknown }).error === FEEDS_NOT_AUTHORIZED;
  } catch {
    return false;
  }
}

/// The only fields of an entry anything reads (entry.ts); the rest is dropped so it is not kept for the whole tick. A
/// field that is absent stays absent (raw_fp tells an absent fullReport from any value). An entry that is not an object
/// is never read either (every reader skips it), so it is kept as null.
const READ_FIELDS = ['feedID', 'observationsTimestamp', 'fullReport'] as const;
function keepRead(e: unknown): unknown {
  if (e === null || typeof e !== 'object' || Array.isArray(e)) return null;
  const out: Record<string, unknown> = {};
  for (const k of READ_FIELDS) if (Object.prototype.hasOwnProperty.call(e, k)) out[k] = flat((e as Record<string, unknown>)[k]);
  return out;
}

/// A kept value is a number, a boolean, null, or a printable ASCII string, so what a tick holds stays about the body's
/// size (V8 stores such a string one byte a character, and no nested value is kept). Anything else (an object, an array,
/// a string with another character) becomes a fixed tag holding its keccak, so two different values stay different for
/// raw_fp (entry.ts) and junk costs no more than the tag. The tag starts with U+0000, which no kept string can contain.
function flat(v: unknown): unknown {
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string' && /^[\x20-\x7e]*$/.test(v)) return v;
  // JSON.stringify escapes a lone surrogate, which a UTF-8 encoding would turn into U+FFFD (two values, one tag).
  const [kind, text] = typeof v === 'string' ? ['text', JSON.stringify(v)] : ['json', typed(v)];
  return `\u0000${kind}:${keccak256(stringToBytes(text))}`;
}

/// Pure: a 200 body is a page iff it is a JSON object holding a `reports` array.
export function parsePage(text: string): PageEntry[] | null {
  try {
    const v: unknown = JSON.parse(text);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    const reports = (v as { reports?: unknown }).reports;
    // More entries than asked for is not a page: the per-tick work bound assumes at most PAGE_LIMIT (Codex unit C R1, C2).
    return Array.isArray(reports) && reports.length <= PAGE_LIMIT ? (reports.map(keepRead) as PageEntry[]) : null;
  } catch {
    return null;
  }
}

export async function classify(res: Response): Promise<PageResult> {
  const header = res.headers.get('x-request-id');
  const requestId = header !== null && REQUEST_ID.test(header) ? header : null;
  const status = res.status;
  if (status === 401 || status === 403) {
    const { text } = await readCapped(res, REFUSAL_BODY_BYTES);
    return { kind: isFeedRefusal(text) ? 'feed_refused' : 'key_failure', status, requestId };
  }
  if (status === 429) {
    await res.body?.cancel().catch(() => undefined);
    return { kind: 'rate_limited', status, requestId };
  }
  if (status !== 200) {
    await res.body?.cancel().catch(() => undefined);
    return { kind: 'failed', status, reason: status >= 500 && status <= 599 ? 'server_error' : 'bad_status', requestId };
  }
  const { text, truncated } = await readCapped(res, MAX_PAGE_BYTES);
  const reports = truncated ? null : parsePage(text);
  if (!reports) return { kind: 'failed', status, reason: 'bad_body', requestId };
  return { kind: 'ok', status: 200, reports, requestId };
}

export type ClientDeps = {
  fetchImpl: typeof fetch;
  base: string;
  creds: ReportCredentials;
  /// The clock read when each request is signed (Data Streams refuses a signature more than 5 s from its own clock).
  now: () => number;
  hmac?: HmacHex;
  timeoutMs?: number;
  /// Told each answer's status as soon as it arrives, before its body is read or cancelled (a 429 must halt the tick
  /// before any other call can start, plan 4.1).
  onStatus?: (status: number) => void;
  /// Asked after signing, just before the request goes out: false (the tick was halted meanwhile, plan 4.1) means
  /// nothing is sent.
  mayStart?: () => boolean;
};

/// One page request, never throwing.
export function pageClient(d: ClientDeps): PageClient {
  const base = d.base.replace(/\/$/, '');
  return async (feedId, start) => {
    const path = pagePath(feedId, start);
    try {
      const headers = await reportHeaders(path, d.creds.apiKey, d.creds.secret, String(d.now()), d.hmac ?? hmacSha256Hex);
      if (d.mayStart && !d.mayStart()) return { kind: 'unsent', status: 0, requestId: null };
      const res = await d.fetchImpl(`${base}${path}`, { headers, signal: AbortSignal.timeout(d.timeoutMs ?? REPORT_TIMEOUT_MS) });
      d.onStatus?.(res.status);
      return await classify(res);
    } catch {
      return { kind: 'failed', status: 0, reason: 'network', requestId: null };
    }
  };
}
