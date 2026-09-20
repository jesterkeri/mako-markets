// Hand-built calldata and decoders for the few V4 and Multicall3 calls the
// watchdog makes. Only fixed head words of getMarket are read; `question`
// is never decoded (F6). Any structural surprise throws, and the caller
// counts every id in that call as unread.

export const SEL = {
  getMarket: 'eb44fdd3',
  nextMarketId: '406ef2ef',
  resolver: '04f3bcec',
  aggregate3: '82ad56cb',
} as const;

const WORD = 64; // hex characters per 32-byte word

function pad(hexNoPrefix: string): string {
  return hexNoPrefix.padStart(WORD, '0');
}

export function uint(n: number | bigint): string {
  return pad(BigInt(n).toString(16));
}

export function addressWord(addr: string): string {
  return pad(addr.toLowerCase().replace(/^0x/, ''));
}

export function getMarketCalldata(id: number): string {
  return '0x' + SEL.getMarket + uint(id);
}

/// aggregate3((address target, bool allowFailure, bytes callData)[]), every call
/// with allowFailure = true and a 36-byte getMarket calldata.
export function aggregate3GetMarkets(target: string, ids: number[]): string {
  const n = ids.length;
  const tupleWords = 3 + 1 + 2; // target, allowFailure, offset, length, 64 bytes of data
  const tupleBytes = tupleWords * 32;
  let out = '0x' + SEL.aggregate3 + uint(32) + uint(n);
  for (let i = 0; i < n; i++) out += uint(n * 32 + i * tupleBytes);
  const t = addressWord(target);
  for (const id of ids) {
    const data = SEL.getMarket + uint(id); // 36 bytes
    out += t + uint(1) + uint(96) + uint(36) + data.padEnd(2 * WORD, '0');
  }
  return out;
}

function word(hex: string, byteOffset: number): string {
  const start = byteOffset * 2;
  if (!Number.isSafeInteger(byteOffset) || start < 0 || start + WORD > hex.length) throw new Error('abi: out of range');
  return hex.slice(start, start + WORD);
}

function wordBig(hex: string, byteOffset: number): bigint {
  return BigInt('0x' + word(hex, byteOffset));
}

/// A word as a number, rejected unless below 2^maxBits (and always a safe integer).
function wordNum(hex: string, byteOffset: number, maxBits = 53): number {
  const w = wordBig(hex, byteOffset);
  if (w >= 1n << BigInt(Math.min(maxBits, 53))) throw new Error('abi: value too large');
  return Number(w);
}

function ceil32(n: number): number {
  return Math.ceil(n / 32) * 32;
}

/// Bytes [from, to) must all be zero (ABI padding).
function zeroPadding(hex: string, from: number, to: number): void {
  if (/[^0]/.test(hex.slice(from * 2, to * 2))) throw new Error('abi: nonzero padding');
}

function hexBody(v: string): string {
  if (typeof v !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(v)) throw new Error('abi: not hex');
  return v.slice(2).toLowerCase();
}

/// Largest returnData accepted per call: a getMarket result with a 200-byte
/// question is 800 bytes; anything much larger is not a V4 answer.
const MAX_RETURN_BYTES = 4_096;

/// Decodes aggregate3's (bool success, bytes returnData)[] into per-call
/// return data, or null for a call that failed. Only the canonical encoding
/// Solidity produces is accepted: offsets in order and contiguous, each bytes
/// member at 0x40, zero padding, and no trailing data. Anything else throws.
export function decodeAggregate3(resultHex: string, expected: number): (string | null)[] {
  const h = hexBody(resultHex);
  const total = h.length / 2;
  if (wordNum(h, 0) !== 32) throw new Error('abi: bad array offset');
  const n = wordNum(h, 32);
  if (n !== expected) throw new Error('abi: length mismatch');
  const base = 64; // offsets are relative to the start of the offset table
  let next = n * 32;
  const out: (string | null)[] = [];
  for (let i = 0; i < n; i++) {
    const off = wordNum(h, base + i * 32);
    if (off !== next) throw new Error('abi: non-canonical tuple offset');
    const tuple = base + off;
    const success = wordNum(h, tuple);
    if (success !== 0 && success !== 1) throw new Error('abi: bad bool');
    if (wordNum(h, tuple + 32) !== 64) throw new Error('abi: non-canonical bytes offset');
    const len = wordNum(h, tuple + 64);
    if (len > MAX_RETURN_BYTES) throw new Error('abi: return data too long');
    const dataAt = tuple + 96;
    if (dataAt + ceil32(len) > total) throw new Error('abi: bytes out of range');
    zeroPadding(h, dataAt + len, dataAt + ceil32(len));
    out.push(success === 1 ? '0x' + h.slice(dataAt * 2, (dataAt + len) * 2) : null);
    next = off + 96 + ceil32(len);
  }
  if (base + next !== total) throw new Error('abi: trailing data');
  return out;
}

export interface MarketHead {
  id: number;
  mType: number;
  oracleRef: string; // 0x + 64 hex
  createdAt: number;
  closeTime: number;
  bettingCloseTime: number;
  totalYes: bigint;
  totalNo: bigint;
  resolved: boolean;
}

/// Times must be plausible seconds. V4 caps a market at MAX_DURATION = 7 days
/// (d088ced L352-354) and writes these words only in createMarket (L389-390),
/// so a value beyond the year 2100 is a provider answer, not chain state. The
/// bound also keeps every time inside the range ECMAScript `Date` can format
/// (about the year 275760), so no alert line can throw on one.
const MAX_TIMESTAMP_S = 4_102_444_800; // 2100-01-01T00:00:00Z

/// V4 limits `question` to 1-200 bytes (d088ced L356); a missing market has 0.
const MAX_QUESTION_BYTES = 200;

/// Decodes getMarket's returned Market tuple (d088ced L76-108) and projects
/// the head words slice 1 uses: 1 mType, 2 oracleRef, 4 createdAt,
/// 5 closeTime, 6 bettingCloseTime, 7 totalYes, 8 totalNo, 12 resolved.
/// The whole return is validated first, including the fields that are then
/// discarded: only the canonical encoding Solidity produces is accepted
/// (tuple at 0x20, question at tuple + 0x200 with its full padded tail, no
/// trailing data) and every field must fit its declared Solidity width.
export function decodeMarketHead(id: number, dataHex: string): MarketHead {
  const h = hexBody(dataHex);
  const total = h.length / 2;
  if (wordNum(h, 0) !== 32) throw new Error('abi: bad tuple offset');
  const T = 32;
  const at = (k: number) => T + 32 * k;
  const fits = (k: number, bits: number) => {
    if (wordBig(h, at(k)) >> BigInt(bits) !== 0n) throw new Error(`abi: word ${k} exceeds ${bits} bits`);
  };
  fits(0, 160); // creator address
  fits(1, 8); // mType (uint8 enum)
  if (wordNum(h, at(3)) !== 16 * 32) throw new Error('abi: non-canonical question offset');
  fits(9, 32); // yesBettorCount
  fits(10, 32); // noBettorCount
  if (wordNum(h, at(11)) > 3) throw new Error('abi: bad outcome'); // Outcome enum 0-3
  for (const k of [12, 13]) {
    const b = wordNum(h, at(k));
    if (b !== 0 && b !== 1) throw new Error('abi: bad bool');
  }
  fits(14, 16); // protocolFeeBpsSnapshot
  fits(15, 16); // creatorFeeBpsSnapshot
  const qAt = T + 16 * 32;
  const qLen = wordNum(h, qAt);
  if (qLen > MAX_QUESTION_BYTES) throw new Error('abi: question too long');
  const end = qAt + 32 + ceil32(qLen);
  if (end !== total) throw new Error('abi: length mismatch');
  zeroPadding(h, qAt + 32 + qLen, end);
  const time = (k: number) => {
    const v = wordNum(h, at(k));
    if (v > MAX_TIMESTAMP_S) throw new Error(`abi: word ${k} is not a plausible timestamp`);
    return v;
  };
  return {
    id,
    mType: wordNum(h, at(1)),
    oracleRef: '0x' + word(h, at(2)),
    // uint64 in Solidity, bounded here to plausible seconds.
    createdAt: time(4),
    closeTime: time(5),
    bettingCloseTime: time(6),
    totalYes: wordBig(h, at(7)),
    totalNo: wordBig(h, at(8)),
    resolved: wordNum(h, at(12)) === 1,
  };
}

/// A 32-byte word holding an address, returned checksum-free in lowercase.
export function decodeAddressWord(resultHex: unknown): string | null {
  if (typeof resultHex !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(resultHex)) return null;
  if (!/^0x0{24}/.test(resultHex)) return null;
  return '0x' + resultHex.slice(26).toLowerCase();
}

export function decodeUintWord(resultHex: unknown): bigint | null {
  if (typeof resultHex !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(resultHex)) return null;
  return BigInt(resultHex);
}
