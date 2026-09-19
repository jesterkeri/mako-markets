// Delivery (r15 §5.5): the manifest, Telegram packing and sending, and the
// Healthchecks ping with its "accepted" rule.

import { CRITICAL_MESSAGES, HEALTHCHECKS_BODY_MAX, REFUND_ACCOUNT, REFUND_RPC, TELEGRAM_MAX_MESSAGES, TELEGRAM_MESSAGE_CHARS } from './config';
import { formatRanges } from './discovery';
import { send, type Net } from './net';

/// The fixed check codes (r15 §5.5 plus `uo` and `rv` from slice 1). A code
/// outside this set is a programming error.
export const CHECK_CODES = ['pb', 'rr', 'rp', 'se', 'au', 'nc', 'mp', 'ch', 'tg', 'ds', 'uo', 'rv'] as const;
export type CheckCode = (typeof CHECK_CODES)[number];

export function manifestLine(marketIds: number[], codes: string[]): string {
  for (const c of codes) if (!(CHECK_CODES as readonly string[]).includes(c)) throw new Error(`unknown check code ${c}`);
  const ids = marketIds.length ? formatRanges(marketIds) : '-';
  const checks = codes.length ? [...new Set(codes)].sort().join(',') : '-';
  return `manifest ids: ${ids} | checks: ${checks}`;
}

export function refundCommand(mako: string, ids: number[]): string {
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  return (
    `REFUND (one-sided, forceRefund open). Re-read resolved and both pools first, then run: ` +
    `for id in ${sorted.join(' ')}; do cast send ${mako} "forceRefund(uint256)" $id --rpc-url ${REFUND_RPC} --account ${REFUND_ACCOUNT}; done`
  );
}

/// Lines at least this long (the manifest, a long refund command) are split
/// to fill the space left in the current message; shorter lines move whole.
const SPLIT_AT = 1_000;

/// The longest prefix of `s` that fits in `room`, cut after a comma or space.
function cutToFit(s: string, room: number): number {
  if (s.length <= room) return s.length;
  const cut = Math.max(s.lastIndexOf(',', room - 1), s.lastIndexOf(' ', room - 1));
  return cut > 0 ? cut + 1 : room;
}

/// Greedy packing of lines into messages of at most `limit` characters.
/// Returns the messages and, for each input line, the message holding its
/// last piece.
export function pack(lines: string[], limit: number): { messages: string[]; where: number[] } {
  const messages: string[] = [];
  const where: number[] = [];
  let cur = '';
  const flush = () => {
    if (cur) messages.push(cur);
    cur = '';
  };
  const room = () => (cur ? limit - cur.length - 1 : limit);
  for (const line of lines) {
    let rest = line;
    while (rest.length > room()) {
      if (rest.length < SPLIT_AT && rest.length <= limit) {
        flush();
        break;
      }
      const r = room();
      if (r < 64) {
        flush();
        continue;
      }
      const n = cutToFit(rest, r);
      cur = cur ? `${cur}\n${rest.slice(0, n)}` : rest.slice(0, n);
      rest = rest.slice(n);
      flush();
    }
    if (rest) cur = cur ? `${cur}\n${rest}` : rest;
    where.push(messages.length);
  }
  flush();
  return { messages, where };
}

export interface CriticalPack {
  messages: string[];
  /// True when the manifest could not fit and was replaced by a count; the
  /// run is then ineffective (only possible outside the 2,000-market envelope).
  manifestTruncated: boolean;
  /// Keys of the detail lines that made it into a message, with the message index.
  placed: { key: string; message: number }[];
}

/// Messages 1 to 3: header, as many due detail lines as fit, the refund
/// command, and always the full manifest (room reserved for it first).
export function packCriticals(
  header: string,
  due: { key: string; line: string }[],
  command: string | null,
  fullManifest: string,
  limit = TELEGRAM_MESSAGE_CHARS,
  maxMessages = CRITICAL_MESSAGES,
  manifestCount = 0,
): CriticalPack {
  let manifest = fullManifest;
  const build = (k: number) => {
    const lines = [header, ...due.slice(0, k).map((d) => d.line)];
    if (k < due.length) lines.push(`+${due.length - k} more critical (ids in the manifest)`);
    if (command) lines.push(command);
    lines.push(manifest);
    return pack(lines, limit);
  };
  let lo = 0;
  let hi = due.length;
  let manifestTruncated = false;
  if (build(0).messages.length > maxMessages) {
    manifest = `manifest truncated: ${manifestCount} ids do not fit; full list in the Healthchecks body`;
    manifestTruncated = true;
  }
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (build(mid).messages.length <= maxMessages) lo = mid;
    else hi = mid - 1;
  }
  const { messages, where } = build(lo);
  const placed = due.slice(0, lo).map((d, i) => ({ key: d.key, message: where[i + 1] }));
  return { messages, placed, manifestTruncated };
}

/// Message 4: non-critical lines in priority order, stopping at the first
/// line that does not fit so confirmed lines are always a prefix.
export function packNonCritical(header: string, lines: { key: string; line: string }[], limit = TELEGRAM_MESSAGE_CHARS): { message: string | null; placedKeys: string[] } {
  if (!lines.length) return { message: null, placedKeys: [] };
  const reserve = 48; // room for "+N more next run"
  let text = header;
  const placedKeys: string[] = [];
  for (const l of lines) {
    const line = l.line.length > limit - header.length - reserve - 2 ? l.line.slice(0, limit - header.length - reserve - 5) + '...' : l.line;
    if (text.length + 1 + line.length > limit - reserve) break;
    text += '\n' + line;
    placedKeys.push(l.key);
  }
  const left = lines.length - placedKeys.length;
  if (left > 0) text += `\n+${left} more next run`;
  return { message: text, placedKeys };
}

// ---------------------------------------------------------------------------
// Telegram

export interface TelegramTarget {
  token: string;
  chatId: string;
  dryRun: boolean;
  log: (line: string) => void;
}

/// Sends each message in order, at most TELEGRAM_MAX_MESSAGES requests in
/// total. A 429 is retried once only if its retry_after ends before the
/// deadline and a request remains. Returns which messages Telegram confirmed.
export async function sendTelegram(net: Net, t: TelegramTarget, texts: string[]): Promise<boolean[]> {
  const confirmed = texts.map(() => false);
  let used = 0;
  for (let i = 0; i < texts.length; i++) {
    if (t.dryRun) {
      t.log(`[dry-run telegram ${i + 1}/${texts.length}]\n${texts[i]}`);
      confirmed[i] = true;
      continue;
    }
    for (let attempt = 0; attempt < 2 && used < TELEGRAM_MAX_MESSAGES; attempt++) {
      used++;
      const r = await send(net, `https://api.telegram.org/bot${t.token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: t.chatId, text: texts[i], disable_web_page_preview: true }),
      });
      if (r.ok) {
        try {
          confirmed[i] = (JSON.parse(r.text) as { ok?: unknown }).ok === true;
        } catch {
          confirmed[i] = false;
        }
        break;
      }
      if (r.kind !== 'rate_limited') break;
      let retryAfter = NaN;
      try {
        retryAfter = Number((JSON.parse(r.text ?? '') as { parameters?: { retry_after?: unknown } }).parameters?.retry_after);
      } catch {
        // no retry_after: undelivered
      }
      const waitMs = retryAfter * 1000;
      if (!Number.isFinite(waitMs) || waitMs < 0 || net.now() + waitMs >= net.deadlineAt) break;
      await net.sleep(waitMs);
    }
  }
  return confirmed;
}

// ---------------------------------------------------------------------------
// Healthchecks

export type PingKind = 'success' | 'fail' | 'log';

export interface PingOutcome {
  accepted: boolean;
  reason: string;
}

export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/// Accepted by Healthchecks only if: HTTPS to the configured check URL,
/// status 200, body exactly "OK", and a Ping-Body-Limit header at least the
/// body size sent (r15 §5.5). Anything else is not accepted.
export async function pingHealthchecks(
  net: Net,
  checkUrl: string,
  kind: PingKind,
  body: string,
  dryRun: boolean,
  log: (line: string) => void,
): Promise<PingOutcome> {
  if (!/^https:\/\/[^/]+\/.+/.test(checkUrl)) return { accepted: false, reason: 'check URL is not HTTPS' };
  let payload = body;
  if (byteLength(payload) > HEALTHCHECKS_BODY_MAX) payload = payload.slice(0, HEALTHCHECKS_BODY_MAX - 64) + '\n[summary truncated]';
  if (dryRun) {
    log(`[dry-run healthchecks ${kind}]\n${payload}`);
    return { accepted: true, reason: 'dry run' };
  }
  const url = kind === 'success' ? checkUrl : `${checkUrl.replace(/\/$/, '')}/${kind}`;
  const r = await send(net, url, { method: 'POST', headers: { 'content-type': 'text/plain; charset=utf-8' }, body: payload });
  if (!r.ok) return { accepted: false, reason: `${r.kind}${r.status ? ' ' + r.status : ''}` };
  if (r.status !== 200) return { accepted: false, reason: `status ${r.status}` };
  if (r.text !== 'OK') return { accepted: false, reason: `body ${JSON.stringify(r.text.slice(0, 40))}` };
  const limitHeader = r.headers.get('Ping-Body-Limit');
  if (limitHeader === null || !/^\d+$/.test(limitHeader.trim())) return { accepted: false, reason: 'no Ping-Body-Limit' };
  if (Number(limitHeader.trim()) < byteLength(payload)) return { accepted: false, reason: 'Ping-Body-Limit below body size' };
  return { accepted: true, reason: '' };
}
