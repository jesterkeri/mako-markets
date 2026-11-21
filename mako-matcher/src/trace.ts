// geth `callTracer` output (debug_traceCall, debug_traceTransaction): parsing, the revert a trace shows, and the
// check frames of contract parties (plan 6.2 "Settle" step 1 and "Out of gas in a sent transaction").
import { decodeErrorResult, type Hex } from 'viem';
import { EXCHANGE_ABI } from './abi';
import { SAFE_4337_MODULE, SAFE_SINGLETON } from './wallets';

export interface CallFrame {
  type: string;
  from: Hex;
  to: Hex | null;
  input: Hex;
  output: Hex | null;
  error: string | null;
  calls: CallFrame[];
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const HEX = /^0x[0-9a-fA-F]*$/;
const MAX_DEPTH = 64;

/// A callTracer result, or null when it is not one. Strict: a trace we cannot read is "no trace".
export function parseTrace(t: unknown, depth = 0): CallFrame | null {
  if (typeof t !== 'object' || t === null || depth > MAX_DEPTH) return null;
  const f = t as Record<string, unknown>;
  if (typeof f.type !== 'string' || typeof f.from !== 'string' || !ADDR.test(f.from)) return null;
  const to = f.to === undefined || f.to === null ? null : f.to;
  if (to !== null && (typeof to !== 'string' || !ADDR.test(to))) return null;
  const input = f.input === undefined ? '0x' : f.input;
  if (typeof input !== 'string' || !HEX.test(input)) return null;
  const output = f.output === undefined || f.output === null ? null : f.output;
  if (output !== null && (typeof output !== 'string' || !HEX.test(output))) return null;
  const error = f.error === undefined || f.error === null ? null : f.error;
  if (error !== null && typeof error !== 'string') return null;
  const rawCalls = f.calls === undefined ? [] : f.calls;
  if (!Array.isArray(rawCalls)) return null;
  const calls: CallFrame[] = [];
  for (const c of rawCalls) {
    const p = parseTrace(c, depth + 1);
    if (!p) return null;
    calls.push(p);
  }
  return { type: f.type, from: f.from.toLowerCase() as Hex, to: (to as string | null)?.toLowerCase() as Hex | null, input: input.toLowerCase() as Hex, output: (output as string | null)?.toLowerCase() as Hex | null, error, calls };
}

export interface RevertInfo {
  /// The exchange's custom error, or null when the output is empty or not one of its errors.
  name: string | null;
  args: readonly unknown[];
  outOfGas: boolean;
}

/// What the top frame shows: null when the call did not fail.
export function topRevert(top: CallFrame): RevertInfo | null {
  if (top.error === null) return null;
  const outOfGas = /out of gas/i.test(top.error);
  if (top.output && top.output.length >= 10) {
    try {
      const e = decodeErrorResult({ abi: EXCHANGE_ABI, data: top.output });
      return { name: e.errorName, args: (e.args ?? []) as readonly unknown[], outOfGas: outOfGas || e.errorName === 'InsufficientGas' };
    } catch {
      /* not one of the exchange's errors */
    }
  }
  return { name: null, args: [], outOfGas };
}

/// 0x...01, the ecrecover precompile.
export const ECRECOVER: Hex = '0x0000000000000000000000000000000000000001';
/// `isValidSignature(bytes32,bytes)`, the call the exchange makes on a contract party (plan 4.2).
export const IS_VALID_SIGNATURE = '0x1626ba7e';

export interface CheckFrame {
  party: Hex;
  /// Every address that ran code inside the check frame (the frame's own target, nested targets, delegate targets).
  ran: Set<Hex>;
}

function walk(f: CallFrame, visit: (f: CallFrame) => void) {
  visit(f);
  for (const c of f.calls) walk(c, visit);
}

/// The frame the exchange itself calls on each given party's address to check its signature, with every address
/// that ran code inside it. A party with no such frame is absent from the result.
export function checkFrames(top: CallFrame, exchange: Hex, parties: Hex[]): Map<Hex, CheckFrame[]> {
  const ex = exchange.toLowerCase();
  const out = new Map<Hex, CheckFrame[]>();
  walk(top, (f) => {
    if (f.from !== ex || f.to === null || !f.input.startsWith(IS_VALID_SIGNATURE)) return;
    const party = parties.find((p) => p.toLowerCase() === f.to);
    if (!party) return;
    const ran = new Set<Hex>();
    walk(f, (g) => {
      if (g.to !== null) ran.add(g.to);
    });
    const list = out.get(party) ?? [];
    list.push({ party, ran });
    out.set(party, list);
  });
  return out;
}

/// plan 4.6: the code addresses allowed in a supported wallet's check frame: the proxy, the singleton, the handler
/// and the ecrecover precompile.
export function allowedFor(party: Hex): Set<Hex> {
  return new Set<Hex>([party.toLowerCase() as Hex, SAFE_SINGLETON, SAFE_4337_MODULE, ECRECOVER]);
}

/// The addresses a party's check frames ran that are not on the allowlist.
export function outsiders(frames: CheckFrame[], party: Hex): Hex[] {
  const ok = allowedFor(party);
  const bad = new Set<Hex>();
  for (const f of frames) for (const a of f.ran) if (!ok.has(a)) bad.add(a);
  return [...bad];
}
