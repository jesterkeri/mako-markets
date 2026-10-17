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

/// keccak256 of the report bytes. A value that is not hex is hashed as its UTF-8 text, so a malformed entry still has
/// a stable identity in raw_fp (and is invalid everywhere else).
export function reportKey(fullReport: unknown): Hex {
  if (typeof fullReport === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(fullReport)) return keccak256(fullReport.toLowerCase() as Hex);
  return keccak256(stringToBytes(typeof fullReport === 'string' ? fullReport : JSON.stringify(fullReport ?? null)));
}

export type RawEntry = { obs: number; key: Hex };

/// The entry as raw_fp sees it: JSON feedID equals the feed and JSON observationsTimestamp is a second. Nothing else
/// is read.
export function rawEntry(e: PageEntry, feed: Feed): RawEntry | null {
  if (typeof e.feedID !== 'string' || e.feedID.toLowerCase() !== feed.feedId) return null;
  const obs = jsonSecond(e.observationsTimestamp);
  if (obs === null) return null;
  return { obs, key: reportKey(e.fullReport) };
}

export type ValidEntry = { obs: number; key: Hex; report: DecodedReport; price: bigint };

/// Plan 3.1 validEntry: the entry is the requested feed's; `fullReport` splits into the envelope; the blob decodes with
/// the feed's pinned schema through the resolver's decodeVerified; the decoded feedId and observationsTimestamp equal
/// the JSON ones; validFrom <= observations; price > 0; for v8 0 < lastUpdateTimestamp < (obs + 1) * 1e9.
export function validEntry(e: PageEntry, feed: Feed): ValidEntry | null {
  if (typeof e.feedID !== 'string' || e.feedID.toLowerCase() !== feed.feedId) return null;
  const obs = jsonSecond(e.observationsTimestamp);
  if (obs === null) return null;
  const blob = reportBlob(e.fullReport);
  if (blob === null) return null;
  const report = decodeVerified(blob, feed.schema);
  if (report === null) return null;
  if (report.feedId !== feed.feedId || report.observationsTimestamp !== obs) return null;
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
