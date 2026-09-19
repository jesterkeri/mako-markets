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
  if (start < 0 || start + WORD > hex.length) throw new Error('abi: out of range');
  return hex.slice(start, start + WORD);
}

function wordNum(hex: string, byteOffset: number, maxBits = 53): number {
  const w = BigInt('0x' + word(hex, byteOffset));
  if (w >= 1n << BigInt(maxBits)) throw new Error('abi: value too large');
  return Number(w);
}

/// Decodes aggregate3's (bool success, bytes returnData)[] into per-call
/// return data, or null for a call that failed.
export function decodeAggregate3(resultHex: string, expected: number): (string | null)[] {
  if (typeof resultHex !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(resultHex)) throw new Error('abi: not hex');
  const h = resultHex.slice(2).toLowerCase();
  const arr = wordNum(h, 0);
  const n = wordNum(h, arr);
  if (n !== expected) throw new Error('abi: length mismatch');
  const base = arr + 32;
  const out: (string | null)[] = [];
  for (let i = 0; i < n; i++) {
    const tuple = base + wordNum(h, base + i * 32);
    const success = wordNum(h, tuple);
    if (success !== 0 && success !== 1) throw new Error('abi: bad bool');
    const dataAt = tuple + wordNum(h, tuple + 32);
    const len = wordNum(h, dataAt);
    const start = (dataAt + 32) * 2;
    if (start + len * 2 > h.length) throw new Error('abi: bytes out of range');
    out.push(success === 1 ? h.slice(start, start + len * 2) : null);
  }
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

/// Head words of getMarket's returned Market tuple (d088ced L76-108):
/// 1 mType, 2 oracleRef, 4 createdAt, 5 closeTime, 6 bettingCloseTime,
/// 7 totalYes, 8 totalNo, 12 resolved. Word k sits at byte 32 + 32k because
/// word 0 of the return data is the tuple offset (0x20).
export function decodeMarketHead(id: number, dataHex: string): MarketHead {
  const h = dataHex.replace(/^0x/, '').toLowerCase();
  if (h.length < (32 + 16 * 32) * 2) throw new Error('abi: market too short');
  if (wordNum(h, 0) !== 32) throw new Error('abi: bad tuple offset');
  const at = (k: number) => 32 + 32 * k;
  const mTypeWord = BigInt('0x' + word(h, at(1)));
  if (mTypeWord > 255n) throw new Error('abi: bad enum');
  const resolved = wordNum(h, at(12));
  if (resolved !== 0 && resolved !== 1) throw new Error('abi: bad bool');
  return {
    id,
    mType: Number(mTypeWord),
    oracleRef: '0x' + word(h, at(2)),
    createdAt: wordNum(h, at(4)),
    closeTime: wordNum(h, at(5)),
    bettingCloseTime: wordNum(h, at(6)),
    totalYes: BigInt('0x' + word(h, at(7))),
    totalNo: BigInt('0x' + word(h, at(8))),
    resolved: resolved === 1,
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
