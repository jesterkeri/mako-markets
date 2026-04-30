// ----------------------------------------------------------------------------
// src/lib/aa-signature.ts
//
// Pack a 65-byte ECDSA secp256k1 signature into the 77-byte SafeOp signature
// envelope that Safe4337Module v0.3.0 expects.
//
// Envelope layout (77 bytes total):
//   0..6     validAfter   (uint48, big-endian)
//   6..12    validUntil   (uint48, big-endian)
//   12..44   r            (32 bytes)
//   44..76   s            (32 bytes)
//   76..77   safeV        (1 byte; 31 or 32)
//
// `safeV` semantics:
//   The wallet (Magic personal_sign / viem `sign()` / etc.) returns the raw
//   recovery byte as 0/1 (yParity-style) or 27/28 (canonical EIP-2). We
//   normalize to 27/28 and then bump by +4 to mark this as a Safe
//   `eth_sign`/`personal_sign` envelope. Inside `Safe.checkSignatures`, the
//   v - 4 path strips the marker, then re-applies the personal_sign
//   recovery (EIP-191 prefix). Without the +4 adjustment, the Safe module
//   would attempt direct-hash recovery and fail.
//
// Hard rejects:
//   - EIP-155 chain-prefixed v values (35+) — not supported by the Safe
//     `v - 4` path; throw post-normalization rather than producing a
//     signature that silently fails on-chain.
//   - Anything that's not 0/1/27/28 after the v < 27 ? +27 : v adjustment.
//
// Pure. No env, no server-only, no I/O. Both the browser (calling Magic)
// and the server (validating an envelope on receive) use this module.
// ----------------------------------------------------------------------------

import { concat, type Hex } from 'viem';

import { uint48ToBytes6BE } from './encoding';

const SIG_LENGTH_BYTES = 65;
const ENVELOPE_LENGTH_BYTES = 77;

const HEX_LEN_RAW_SIG = 2 + SIG_LENGTH_BYTES * 2;     // 0x + 130 chars
const HEX_LEN_ENVELOPE = 2 + ENVELOPE_LENGTH_BYTES * 2; // 0x + 154 chars

/// Strict 0x-prefixed lowercase hex matcher (caller already lowercased).
/// Rejects mixed-case inputs only after the caller's `.toLowerCase()`,
/// and any non [0-9a-f] byte. Length is checked separately so the error
/// message can distinguish "wrong length" from "wrong alphabet."
function assertHexAlphabet(hex: string, label: string): void {
  if (!/^0x[0-9a-f]*$/.test(hex)) {
    throw new Error(
      `aa-signature: ${label} contains non-hex characters`,
    );
  }
}

/// Normalize an ECDSA recovery byte to canonical 27 or 28. Throws on
/// anything that won't recover correctly under the Safe `v - 4`
/// personal_sign path (EIP-155 chain-prefixed v, malformed values).
export function normalizeEcdsaV(v: number): 27 | 28 {
  if (!Number.isInteger(v)) {
    throw new Error(`aa-signature: v must be an integer, got ${v}`);
  }
  const adjusted = v < 27 ? v + 27 : v;
  if (adjusted !== 27 && adjusted !== 28) {
    throw new Error(
      `aa-signature: unexpected v=${v} (post-normalize=${adjusted}). ` +
        'Expected 0/1/27/28 — chain-prefixed v values (e.g. EIP-155 35+) ' +
        'are not supported by the Safe eth_sign envelope.',
    );
  }
  return adjusted as 27 | 28;
}

/// Build the 77-byte SafeOp signature envelope from raw ECDSA components
/// plus the validity window. `rawSignature` is the 65-byte secp256k1
/// signature in r||s||v form as a 0x-prefixed hex string.
export function buildSafeOpEnvelope(args: {
  rawSignature: Hex;
  validAfter: bigint;
  validUntil: bigint;
}): Hex {
  const hex = args.rawSignature.toLowerCase();
  if (!hex.startsWith('0x') || hex.length !== HEX_LEN_RAW_SIG) {
    throw new Error(
      `aa-signature: rawSignature must be 0x-prefixed 65-byte hex ` +
        `(${HEX_LEN_RAW_SIG} chars), got length ${hex.length}`,
    );
  }
  assertHexAlphabet(hex, 'rawSignature');
  const r = ('0x' + hex.slice(2, 2 + 32 * 2)) as Hex;
  const s = ('0x' + hex.slice(2 + 32 * 2, 2 + 64 * 2)) as Hex;
  const vByte = parseInt(hex.slice(2 + 64 * 2), 16);
  if (Number.isNaN(vByte)) {
    throw new Error(
      `aa-signature: failed to parse v byte from ${args.rawSignature}`,
    );
  }

  const normalized = normalizeEcdsaV(vByte);
  const safeV = (normalized + 4) as 31 | 32;

  const envelope = concat([
    uint48ToBytes6BE(args.validAfter),
    uint48ToBytes6BE(args.validUntil),
    r,
    s,
    `0x${safeV.toString(16).padStart(2, '0')}` as Hex,
  ]);

  if (envelope.length !== HEX_LEN_ENVELOPE) {
    throw new Error(
      `aa-signature: assembled envelope is wrong length ` +
        `(${envelope.length}, expected ${HEX_LEN_ENVELOPE})`,
    );
  }

  return envelope;
}

/// Parse a 77-byte SafeOp envelope into its components. Used by the
/// `/api/aa/send` route as a fast pre-check before the more expensive
/// drift-guard signature recovery. Rejects malformed inputs.
export function parseSafeOpEnvelope(envelope: Hex): {
  validAfter: bigint;
  validUntil: bigint;
  r: Hex;
  s: Hex;
  safeV: 31 | 32;
} {
  const hex = envelope.toLowerCase();
  if (!hex.startsWith('0x') || hex.length !== HEX_LEN_ENVELOPE) {
    throw new Error(
      `aa-signature: envelope must be 0x-prefixed 77-byte hex ` +
        `(${HEX_LEN_ENVELOPE} chars), got length ${hex.length}`,
    );
  }
  assertHexAlphabet(hex, 'envelope');
  const validAfterHex = ('0x' + hex.slice(2, 2 + 6 * 2)) as Hex;
  const validUntilHex = ('0x' + hex.slice(2 + 6 * 2, 2 + 12 * 2)) as Hex;
  const r = ('0x' + hex.slice(2 + 12 * 2, 2 + 44 * 2)) as Hex;
  const s = ('0x' + hex.slice(2 + 44 * 2, 2 + 76 * 2)) as Hex;
  const safeVByte = parseInt(hex.slice(2 + 76 * 2), 16);
  if (safeVByte !== 31 && safeVByte !== 32) {
    throw new Error(
      `aa-signature: envelope safeV=${safeVByte}, expected 31 or 32`,
    );
  }
  return {
    validAfter: BigInt(validAfterHex),
    validUntil: BigInt(validUntilHex),
    r,
    s,
    safeV: safeVByte as 31 | 32,
  };
}
