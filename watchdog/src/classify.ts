// Per-market classification (r15 §5.2), the unsupported-oracle check (UO),
// creation checks, and flap control for probe checks. Pure functions: the
// run feeds them what it read and stores what they return.

import { RESOLUTION_GRACE_S } from './config';
import type { MarketHead } from './abi';
import { isPriceType, isSportsType, MARKET_TYPE, PAUSED_SYMBOLS, typeName } from './assets';
import { classifyOracleRef } from './oracle-ref';

const MIN = 60;
const HOUR = 3600;

/// Total by construction: an alert line must never be the thing that stops a
/// run. `Date` covers about +/- 8.64e12 seconds, and the decoder already
/// rejects implausible times, so this fallback should be unreachable; it is
/// here so that a formatting path can never throw out of the run.
export function fmtUtc(unixS: number): string {
  const d = new Date(unixS * 1000);
  // Out of Date's range (about +/- 8.64e12 seconds), NaN or infinite: say so
  // rather than throw. toISOString() would throw RangeError here.
  if (Number.isNaN(d.getTime())) return `unix ${unixS}`;
  return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

/// Total, in milliseconds, for the run header and the crash report. A cron
/// event always carries a valid scheduled time, but the crash guard is the
/// last boundary before silence, so its own formatting must not throw
/// (review r7).
export function fmtIsoMs(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return `ms ${ms}`;
  return d.toISOString();
}

export function fmtAge(seconds: number): string {
  if (seconds < HOUR) return `${Math.floor(seconds / MIN)}m`;
  if (seconds < 48 * HOUR) return `${Math.floor(seconds / HOUR)}h`;
  return `${Math.floor(seconds / (24 * HOUR))}d ${Math.floor((seconds % (24 * HOUR)) / HOUR)}h`;
}

/// USDC has 6 decimals.
export function fmtUsdc(v: bigint): string {
  const whole = v / 1_000_000n;
  const cents = (v % 1_000_000n) / 10_000n;
  return `${whole}.${cents.toString().padStart(2, '0')}`;
}

export function isOneSided(m: MarketHead): boolean {
  return m.totalYes === 0n || m.totalNo === 0n;
}

/// forceRefund opens at closeTime + 24h (d088ced L579); one-sided markets
/// end in REFUND on every path, so only they get a command (I7).
export function commandAllowed(m: MarketHead, nowS: number): boolean {
  return !m.resolved && m.closeTime > 0 && isOneSided(m) && nowS >= m.closeTime + RESOLUTION_GRACE_S;
}

export type Severity = 'none' | 'warn' | 'critical' | 'digest';

export interface MarketVerdict {
  severity: Severity;
  line: string;
  command: boolean;
}

/// Where a refund command stands this run (run.ts):
/// - `confirmed`: the public RPC returned this market identically at the same block;
/// - `withheld`: it was checked and not confirmed (disagreement, unreadable, down);
/// - `deferred`: not checked this run for budget; its alert stays due, so the next run checks it first;
/// - `unchecked`: its alert is not due this run, so it was not checked.
export type CommandStatus = 'confirmed' | 'withheld' | 'deferred' | 'unchecked';

/// The §5.2 table. `nowS` is the finalized block's timestamp, the same clock
/// the contract uses. A command is offered only when `command` is
/// `confirmed`, whatever the table says (fail closed).
export function classifyStuck(m: MarketHead, nowS: number, command: CommandStatus = 'unchecked'): MarketVerdict {
  const none: MarketVerdict = { severity: 'none', line: '', command: false };
  if (m.resolved || m.closeTime === 0 || nowS < m.closeTime) return none;
  const age = nowS - m.closeTime;
  const oneSided = isOneSided(m);
  const allowed = commandAllowed(m, nowS);
  const offer = allowed && command === 'confirmed';
  const pools = `YES ${fmtUsdc(m.totalYes)} / NO ${fmtUsdc(m.totalNo)}`;
  const head = `#${m.id} ${typeName(m.mType)} ${oneSided ? 'one-sided' : 'two-sided'}, unresolved ${fmtAge(age)} after close (${pools})`;
  const pastGrace = age >= RESOLUTION_GRACE_S;
  const refundNote = oneSided
    ? offer
      ? 'refund command below'
      : allowed
        ? command === 'withheld'
          ? 'refund command withheld: a second provider did not confirm this market at the same block'
          : command === 'deferred'
            ? 'refund command in a later run (commands are offered in batches)'
            : 'refund command with the next reminder'
        : `refund opens ${fmtUtc(m.closeTime + RESOLUTION_GRACE_S)}`
    : pastGrace
      ? m.mType === MARKET_TYPE.MAKO
        ? 'no safe refund path on V4; resolve it from /admin/resolve'
        : 'no safe refund path on V4'
      : '';
  const line = refundNote ? `${head}: ${refundNote}` : head;

  // Every two-sided market, any type, past close + 24h is critical (r15 §5.2).
  if (!oneSided && pastGrace) return { severity: 'critical', line, command: false };

  if (m.mType === MARKET_TYPE.MAKO) {
    return age >= 24 * HOUR ? { severity: 'digest', line, command: offer } : none;
  }
  if (isSportsType(m.mType)) {
    if (age >= 24 * HOUR) return { severity: 'critical', line, command: offer };
    if (age >= 6 * HOUR) return { severity: 'warn', line, command: offer };
    return none;
  }
  // Price types, and any unknown type (which is also UO).
  if (age >= HOUR) return { severity: 'critical', line, command: offer };
  if (age >= 10 * MIN) return { severity: 'warn', line, command: offer };
  return none;
}

/// UO: an unresolved non-MAKO market whose reference the resolver would skip
/// forever, or whose type byte is outside 0 to 6.
export function unsupportedOracle(m: MarketHead, nowS: number): string | null {
  if (m.resolved) return null;
  if (classifyOracleRef(m.mType, m.oracleRef).kind !== 'unsupported') return null;
  const betting = nowS < m.bettingCloseTime ? `betting open until ${fmtUtc(m.bettingCloseTime)}` : `betting closed ${fmtUtc(m.bettingCloseTime)}`;
  return (
    `#${m.id} PUBLIC market (${typeName(m.mType)}): oracle reference not supported, the resolver cannot settle it; ` +
    `${betting}; pools YES ${fmtUsdc(m.totalYes)} / NO ${fmtUsdc(m.totalNo)}`
  );
}

/// MIRROR_CRYPTO_CUTOFF: local copy of V4's suggestedCryptoBettingCloseTime
/// (d088ced L455-468), checked against values read from the contract in
/// test/classify.test.ts. The app's copy is src/lib/market-timing.ts.
export function suggestedCryptoCutoff(createdAt: number, resolutionTime: number): number {
  if (resolutionTime <= createdAt) return createdAt;
  const duration = resolutionTime - createdAt;
  const pct = duration <= HOUR ? 50 : duration <= 24 * HOUR ? 60 : duration <= 72 * HOUR ? 70 : 85;
  return createdAt + Math.floor((duration * pct) / 100);
}

/// Creation checks. They read only fields V4 writes once, in createMarket
/// (d088ced L385-390), so the same id always gives the same answer. Markets
/// that existed before the watchdog are checked only while open, and labelled.
export function creationFindings(m: MarketHead, preExisting: boolean): string[] {
  if (preExisting && m.resolved) return [];
  const label = preExisting ? `BEFORE WATCHDOG #${m.id}` : `NEW #${m.id}`;
  const out: string[] = [];
  if (isPriceType(m.mType)) {
    const v = classifyOracleRef(m.mType, m.oracleRef);
    if (v.kind === 'supported' && v.symbol && PAUSED_SYMBOLS.has(v.symbol)) {
      out.push(`${label} ${typeName(m.mType)} ${v.symbol}: paused symbol, no verified Data Streams feed`);
    }
  }
  if (m.mType === MARKET_TYPE.CRYPTO) {
    const suggested = suggestedCryptoCutoff(m.createdAt, m.closeTime);
    if (m.bettingCloseTime > suggested) {
      out.push(
        `${label} CRYPTO: betting closes ${fmtAge(m.bettingCloseTime - suggested)} after the suggested cutoff ` +
          `(${fmtUtc(m.bettingCloseTime)} vs ${fmtUtc(suggested)})`,
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Flap control: a probe check changes state only after holding the new state
// for two observations in a row.

export type Obs = 'ok' | 'fail';

export interface CheckRow {
  code: string;
  state: Obs;
  since: number;
  observed: Obs;
  streak: number;
  detail: string;
}

export function applyFlap(prev: CheckRow | undefined, code: string, obs: Obs, detail: string, nowMs: number): CheckRow {
  const p: CheckRow = prev ?? { code, state: 'ok', since: nowMs, observed: 'ok', streak: 0, detail: '' };
  if (obs === p.state) return { ...p, observed: obs, streak: 0, detail: obs === 'fail' ? detail : p.detail };
  const streak = (p.observed === obs ? p.streak : 0) + 1;
  if (streak >= 2) return { code, state: obs, since: nowMs, observed: obs, streak: 0, detail };
  return { ...p, observed: obs, streak, detail: p.detail };
}
