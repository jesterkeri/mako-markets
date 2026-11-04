// ----------------------------------------------------------------------------
// price-recorder/src/entry.ts
//
// What one entry of a `/api/v1/reports/page` answer is worth (CHARTS_DS_PLAN 3.1 and 3.3):
//   * rawEntry: reads only two JSON fields (feedID, observationsTimestamp) and hashes the report bytes. No decoder, no
//     schema, no validation. It feeds raw_fp, the provider-contradiction signal.
//   * validEntry: applied to EVERY fetched entry. Only a valid entry can be a candle input, an exhaustion witness or a
//     `latest` candidate. No time-window condition and no expiry check: an old report is history.
//   * candleInput and exhaustionWitness: the two window predicates, kept separate on purpose.
// ----------------------------------------------------------------------------

import { keccak256, stringToBytes, type Hex } from 'viem';

import { decodeVerified, type DecodedReport } from '../../cf-worker/src/datastreams';
import type { Feed } from './feeds';
import { reportBlob } from './envelope';
import { MINUTE_S } from './rules';

export type PageEntry = Readonly<Record<string, unknown>>;

/// A JSON second: a decimal string or a safe integer, nothing else (no "1e9", no "12.0", no sign).
export function jsonSecond(v: unknown): number | null {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? v : null;
  if (typeof v === 'string' && /^(0|[1-9][0-9]{0,14})$/.test(v)) return Number(v);
  return null;
}

/// keccak256 of the report bytes (plan 3.3). A value that is not hex still gets a stable identity in raw_fp (and is
/// invalid everywhere else): keccak256 over a one-byte tag and its text, 0x01 for a non-hex string, 0x02 for anything
/// else as JSON, so `null`, "null" and the hex bytes of "null" stay three different entries.
export function reportKey(fullReport: unknown): Hex {
  if (typeof fullReport === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(fullReport)) return keccak256(fullReport.toLowerCase() as Hex);
  const [tag, text] = typeof fullReport === 'string' ? [1, fullReport] : [2, typed(fullReport ?? null)];
  return keccak256(new Uint8Array([tag, ...stringToBytes(text)]));
}

/// `id` is the entry's exact identity for de-duplication (plan 3.3: "de-duplicated by identical bytes"): its second and
/// its `fullReport` exactly as sent, with the kind kept apart (hex bytes, other text, another JSON value, absent), so
/// two different values are never one entry. `key` is only the fingerprint item; for a hex report it is the plain
/// keccak of the bytes, so any byte string can reach any key and keys alone cannot be the identity.
export type RawEntry = { obs: number; key: Hex; id: string };

export function rawId(obs: number, e: PageEntry): string {
  const v = e.fullReport;
  if (!('fullReport' in e) || v === undefined) return JSON.stringify([obs, 'absent']);
  if (typeof v === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(v)) return JSON.stringify([obs, 'hex', v.toLowerCase()]);
  if (typeof v === 'string') return JSON.stringify([obs, 'text', v]);
  return JSON.stringify([obs, 'json', typed(v)]);
}

/// JSON.stringify is not one-to-one on parsed values (Infinity and NaN print as null, -0 as 0), so every number and string
/// is tagged with its exact text first. A value too deep to print cannot crash the minute: it gets one fixed identity.
// shortcut: two different unprintable values (a fullReport or feedID nested thousands deep) count as one; a page
// like that is never a report.
export function typed(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, x: unknown) => (typeof x === 'number' ? `n:${Object.is(x, -0) ? '-0' : String(x)}` : typeof x === 'string' ? `s:${x}` : x)) ?? 'undefined';
  } catch {
    return 'unprintable';
  }
}

/// The JSON second of an entry of `feed`, or null if the JSON feedID is another feed's or the second is malformed.
const feedSecond = (e: PageEntry, feed: Feed): number | null =>
  typeof e.feedID === 'string' && e.feedID.toLowerCase() === feed.feedId ? jsonSecond(e.observationsTimestamp) : null;

/// The entry as raw_fp sees it: JSON feedID equals the feed and JSON observationsTimestamp is a second. Nothing else
/// is read.
export function rawEntry(e: PageEntry, feed: Feed): RawEntry | null {
  const obs = feedSecond(e, feed);
  if (obs === null) return null;
  return { obs, key: reportKey(e.fullReport), id: rawId(obs, e) };
}

export type ValidEntry = { obs: number; key: Hex; report: DecodedReport; price: bigint };

/// The first half of validEntry: `fullReport` splits into the envelope, the blob decodes with the feed's pinned schema,
/// and the decoded feedId and observationsTimestamp equal the JSON ones. Such an entry's second is carried by its own
/// bytes, whatever its prices say, so it may move a page restart (fetcher.ts); only a valid entry is evidence.
export function anchoredEntry(e: PageEntry, feed: Feed): { obs: number; report: DecodedReport } | null {
  const obs = feedSecond(e, feed);
  if (obs === null) return null;
  const blob = reportBlob(e.fullReport);
  if (blob === null) return null;
  const report = decodeVerified(blob, feed.schema);
  if (report === null) return null;
  if (report.feedId !== feed.feedId || report.observationsTimestamp !== obs) return null;
  return { obs, report };
}

/// Plan 3.1 validEntry: anchoredEntry; validFrom <= observations; price > 0; for v8
/// 0 < lastUpdateTimestamp < (obs + 1) * 1e9.
export function validEntry(e: PageEntry, feed: Feed): ValidEntry | null {
  const a = anchoredEntry(e, feed);
  if (a === null) return null;
  const { obs, report } = a;
  if (report.validFromTimestamp > report.observationsTimestamp) return null;
  const price = report.schema === 3 ? report.price : report.midPrice;
  if (price <= 0n) return null;
  if (report.schema === 8 && !(report.lastUpdateTimestamp > 0n && report.lastUpdateTimestamp < BigInt(obs + 1) * 1_000_000_000n)) return null;
  return { obs, key: reportKey(e.fullReport), report, price };
}

/// Plan 3.1 candleInput: a valid entry inside minute M = [M, M + 60).
export const candleInput = (v: ValidEntry, M: number): boolean => v.obs >= M && v.obs < M + MINUTE_S;

/// Plan 3.1 exhaustionWitness: a valid entry at or after B proves a span [A, B) exhausted (plan 3.4).
export const exhaustionWitness = (v: ValidEntry, B: number): boolean => v.obs >= B;
