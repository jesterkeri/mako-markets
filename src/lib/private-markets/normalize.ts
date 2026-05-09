// ----------------------------------------------------------------------------
// src/lib/private-markets/normalize.ts
//
// Boundary-conversion helpers between the chain (viem types) and the
// pm_* DB schema (Drizzle types). The pm_markets schema CHECK
// constraints require lowercase EVM addresses + bytes32 hashes; the
// schema's `mode: 'number'` choice on bigint columns caps marketId /
// blockNumber at Number.MAX_SAFE_INTEGER. Every helper here either
// normalises into the canonical DB form or asserts the safe-integer
// bound so accidental drift fails loud.
//
// All helpers are pure; no DB or RPC.
// ----------------------------------------------------------------------------

/// Normalize an EVM address (20 bytes) or bytes32 hash (32 bytes) to
/// the lowercase 0x-hex form the pm_* CHECK constraints accept. Throws
/// on length mismatch or invalid hex. The output is `0x` followed by
/// `byteLen * 2` lowercase hex digits.
export function normalizeHex(
  value: `0x${string}`,
  byteLen: 20 | 32,
): `0x${string}` {
  if (typeof value !== 'string' || !value.startsWith('0x')) {
    throw new Error(`normalizeHex: not a 0x-prefixed string: ${String(value)}`);
  }
  const expectedLen = 2 + byteLen * 2;
  if (value.length !== expectedLen) {
    throw new Error(
      `normalizeHex: expected ${expectedLen} chars (0x + ${byteLen} bytes); got ${value.length}`,
    );
  }
  const lower = value.toLowerCase();
  if (!/^0x[0-9a-f]+$/.test(lower)) {
    throw new Error(`normalizeHex: invalid hex characters in ${value}`);
  }
  return lower as `0x${string}`;
}

/// viem returns block numbers, marketIds, and other uint256-shaped
/// values as `bigint`. The pm_* schema stores them with
/// `bigint('...', { mode: 'number' })`, capping them at
/// Number.MAX_SAFE_INTEGER (~9.0e15). Throws on overflow so silent
/// precision loss is impossible. Negative values are also rejected
/// because the contract never emits negatives for these fields.
export function bigintToNumber(value: bigint): number {
  if (typeof value !== 'bigint') {
    throw new Error(`bigintToNumber: not a bigint: ${String(value)}`);
  }
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`bigintToNumber: value out of safe-integer range: ${value}`);
  }
  return Number(value);
}

/// Inverse of `bigintToNumber`. DB rows surface as `number` for the
/// `mode: 'number'` columns; viem RPC sites (getLogs.fromBlock,
/// multicall args[]) require `bigint`. Asserts the input is a
/// non-negative safe integer for symmetry with bigintToNumber.
export function numberToBigInt(value: number): bigint {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    throw new Error(`numberToBigInt: not a non-negative safe integer: ${value}`);
  }
  return BigInt(value);
}

/// Convert a uint256 seconds-since-epoch value (as emitted by
/// MarketCreated.stakingOpensAt, MarketMetadataFrozen.frozenAt, etc.)
/// to a JS Date. Throws on overflow of JS Date's max representable
/// timestamp (8.64e15 ms = ±100,000,000 days from epoch). The contract
/// can technically emit values that overflow JS Date; we treat that as
/// a hard error rather than corrupting the DB silently.
export function secondsBigIntToDate(seconds: bigint): Date {
  if (typeof seconds !== 'bigint') {
    throw new Error(`secondsBigIntToDate: not a bigint: ${String(seconds)}`);
  }
  if (seconds < 0n) {
    throw new Error(`secondsBigIntToDate: negative timestamp: ${seconds}`);
  }
  // JS Date max is +/-8_640_000_000_000_000 ms = +/-8_640_000_000_000 s
  if (seconds > 8_640_000_000_000n) {
    throw new Error(`secondsBigIntToDate: out of JS Date range: ${seconds}`);
  }
  return new Date(Number(seconds) * 1000);
}

/// Decode a viem-returned `bytes` value (0x-hex) to UTF-8 with a
/// best-effort fallback. The contract stores titles, descriptions,
/// option labels etc. as raw bytes; UTF-8 is the convention but the
/// chain doesn't enforce it. Returns `{ value, ok }`:
///   - ok=true  → decoded UTF-8 string
///   - ok=false → the original lowercase hex string (so the UI shows
///     SOMETHING legible even if the bytes were malformed)
///
/// The round-trip check (re-encode and compare) catches bytes that
/// produce U+FFFD replacement characters under TextDecoder/utf-8 but
/// don't actually round-trip.
export function bytesToUtf8(hex: `0x${string}`): { value: string; ok: boolean } {
  if (!hex.startsWith('0x')) {
    return { value: '', ok: false };
  }
  const lower = hex.toLowerCase() as `0x${string}`;
  if (lower === '0x') {
    return { value: '', ok: true };
  }
  const hexBody = lower.slice(2);
  if (hexBody.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hexBody)) {
    return { value: lower, ok: false };
  }
  try {
    const bytes = new Uint8Array(hexBody.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hexBody.slice(i * 2, i * 2 + 2), 16);
    }
    const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    // Round-trip: re-encode and compare bytes. If the original wasn't
    // valid UTF-8, TextDecoder produced U+FFFD characters that won't
    // re-encode to the same input.
    const reEncoded = new TextEncoder().encode(decoded);
    if (
      reEncoded.length === bytes.length &&
      reEncoded.every((b, i) => b === bytes[i])
    ) {
      return { value: decoded, ok: true };
    }
    return { value: lower, ok: false };
  } catch {
    return { value: lower, ok: false };
  }
}

/// Map the contract's MarketShape enum (uint8) to the lowercase
/// snake_case pm_market_shape DB enum value. Throws on unknown values
/// so a future contract upgrade that adds a fourth shape fails loudly
/// at the indexer rather than silently writing nulls.
export function mapShapeEnum(
  shape: number,
): 'friendly' | 'open_vote' | 'prize_pool' {
  if (shape === 0) return 'friendly';
  if (shape === 1) return 'open_vote';
  if (shape === 2) return 'prize_pool';
  throw new Error(`mapShapeEnum: unknown shape enum value: ${shape}`);
}
