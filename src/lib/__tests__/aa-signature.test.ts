// ----------------------------------------------------------------------------
// src/lib/__tests__/aa-signature.test.ts
//
// Coverage:
//   - normalizeEcdsaV: 0/1 → 27/28; 27/28 passthrough; reject 35+ (EIP-155
//     chain prefix); reject malformed.
//   - buildSafeOpEnvelope: byte layout exactness, validity-window big-endian
//     encoding, safeV = normalized + 4 (i.e. 31 or 32), wrong-length raw sig
//     rejection.
//   - parseSafeOpEnvelope: round-trips a built envelope; rejects bad lengths
//     and bad safeV.
// ----------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';

import {
  normalizeEcdsaV,
  buildSafeOpEnvelope,
  parseSafeOpEnvelope,
} from '../aa-signature';

const R = '0x' + 'aa'.repeat(32);
const S = '0x' + 'bb'.repeat(32);

function buildRawSig(v: number): `0x${string}` {
  return (R + S.slice(2) + v.toString(16).padStart(2, '0')) as `0x${string}`;
}

describe('normalizeEcdsaV', () => {
  it('maps yParity 0 → 27', () => {
    expect(normalizeEcdsaV(0)).toBe(27);
  });
  it('maps yParity 1 → 28', () => {
    expect(normalizeEcdsaV(1)).toBe(28);
  });
  it('passes 27 through', () => {
    expect(normalizeEcdsaV(27)).toBe(27);
  });
  it('passes 28 through', () => {
    expect(normalizeEcdsaV(28)).toBe(28);
  });
  it('rejects EIP-155 chain-prefixed v=35', () => {
    expect(() => normalizeEcdsaV(35)).toThrow(/unexpected v=35/);
  });
  it('rejects EIP-155 chain-prefixed v=99', () => {
    expect(() => normalizeEcdsaV(99)).toThrow(/unexpected v=99/);
  });
  it('rejects v=2 (would normalize to 29, not in {27,28})', () => {
    expect(() => normalizeEcdsaV(2)).toThrow(/unexpected v=2/);
  });
  it('rejects negative v', () => {
    expect(() => normalizeEcdsaV(-1)).toThrow();
  });
  it('rejects non-integer v', () => {
    expect(() => normalizeEcdsaV(1.5)).toThrow(/integer/);
  });
});

describe('buildSafeOpEnvelope', () => {
  it('produces 77-byte hex (154 chars + 0x prefix)', () => {
    const env = buildSafeOpEnvelope({
      rawSignature: buildRawSig(27),
      validAfter: 0n,
      validUntil: 0n,
    });
    expect(env.length).toBe(2 + 77 * 2);
  });

  it('prefixes validAfter|validUntil in big-endian (12 bytes total)', () => {
    const env = buildSafeOpEnvelope({
      rawSignature: buildRawSig(27),
      validAfter: 0x010203040506n,
      validUntil: 0x070809000102n,
    });
    // bytes 0..6 = validAfter (BE); bytes 6..12 = validUntil (BE)
    expect(env.slice(2, 14)).toBe('010203040506');
    expect(env.slice(14, 26)).toBe('070809000102');
  });

  it('safeV = 31 for v=0 (normalized 27 + 4)', () => {
    const env = buildSafeOpEnvelope({
      rawSignature: buildRawSig(0),
      validAfter: 0n,
      validUntil: 0n,
    });
    // Last byte is safeV
    expect(env.slice(-2)).toBe('1f'); // 31 hex
  });

  it('safeV = 32 for v=1 (normalized 28 + 4)', () => {
    const env = buildSafeOpEnvelope({
      rawSignature: buildRawSig(1),
      validAfter: 0n,
      validUntil: 0n,
    });
    expect(env.slice(-2)).toBe('20'); // 32 hex
  });

  it('safeV = 31 for v=27 passthrough', () => {
    const env = buildSafeOpEnvelope({
      rawSignature: buildRawSig(27),
      validAfter: 0n,
      validUntil: 0n,
    });
    expect(env.slice(-2)).toBe('1f');
  });

  it('safeV = 32 for v=28 passthrough', () => {
    const env = buildSafeOpEnvelope({
      rawSignature: buildRawSig(28),
      validAfter: 0n,
      validUntil: 0n,
    });
    expect(env.slice(-2)).toBe('20');
  });

  it('rejects EIP-155 v=35', () => {
    expect(() =>
      buildSafeOpEnvelope({
        rawSignature: buildRawSig(35),
        validAfter: 0n,
        validUntil: 0n,
      }),
    ).toThrow(/unexpected v=35/);
  });

  it('rejects v=99', () => {
    expect(() =>
      buildSafeOpEnvelope({
        rawSignature: buildRawSig(99),
        validAfter: 0n,
        validUntil: 0n,
      }),
    ).toThrow(/unexpected v=99/);
  });

  it('rejects raw signature of wrong length', () => {
    expect(() =>
      buildSafeOpEnvelope({
        rawSignature: '0xdeadbeef',
        validAfter: 0n,
        validUntil: 0n,
      }),
    ).toThrow(/65-byte hex/);
  });

  it('rejects raw signature with non-hex characters', () => {
    // 130-char body but with a 'z' inside. Length passes; alphabet fails.
    const bad = ('0x' + 'aa'.repeat(31) + 'zz' + 'bb'.repeat(32) + '1b') as `0x${string}`;
    expect(() =>
      buildSafeOpEnvelope({
        rawSignature: bad,
        validAfter: 0n,
        validUntil: 0n,
      }),
    ).toThrow(/non-hex/);
  });

  it('rejects validAfter exceeding uint48', () => {
    expect(() =>
      buildSafeOpEnvelope({
        rawSignature: buildRawSig(27),
        validAfter: 0x1000000000000n, // 2^48
        validUntil: 0n,
      }),
    ).toThrow();
  });

  it('rejects negative validUntil', () => {
    expect(() =>
      buildSafeOpEnvelope({
        rawSignature: buildRawSig(27),
        validAfter: 0n,
        validUntil: -1n,
      }),
    ).toThrow();
  });

  it('places r and s in slots 12..44 and 44..76', () => {
    const env = buildSafeOpEnvelope({
      rawSignature: buildRawSig(27),
      validAfter: 0n,
      validUntil: 0n,
    });
    // body without 0x: 0..12=validity, 12..76=r||s, 76..77=safeV
    const body = env.slice(2);
    expect('0x' + body.slice(12 * 2, 44 * 2)).toBe(R);
    expect('0x' + body.slice(44 * 2, 76 * 2)).toBe(S);
  });
});

describe('parseSafeOpEnvelope', () => {
  it('round-trips through buildSafeOpEnvelope', () => {
    const env = buildSafeOpEnvelope({
      rawSignature: buildRawSig(28),
      validAfter: 0x010203040506n,
      validUntil: 0xfffffffffffen,
    });
    const parsed = parseSafeOpEnvelope(env);
    expect(parsed.validAfter).toBe(0x010203040506n);
    expect(parsed.validUntil).toBe(0xfffffffffffen);
    expect(parsed.r).toBe(R);
    expect(parsed.s).toBe(S);
    expect(parsed.safeV).toBe(32);
  });

  it('rejects wrong-length envelope', () => {
    expect(() => parseSafeOpEnvelope('0xdeadbeef')).toThrow(/77-byte hex/);
  });

  it('rejects safeV that is not 31 or 32', () => {
    // Build a valid 77-byte hex with safeV=27 (raw, no +4).
    const bad = ('0x' + '00'.repeat(12) + R.slice(2) + S.slice(2) + '1b') as `0x${string}`;
    expect(() => parseSafeOpEnvelope(bad)).toThrow(/safeV=27/);
  });

  it('rejects envelope with non-hex characters', () => {
    // Right length, malformed character within r.
    const bad = ('0x' + '00'.repeat(12) + 'zz' + 'aa'.repeat(31) + S.slice(2) + '1f') as `0x${string}`;
    expect(() => parseSafeOpEnvelope(bad)).toThrow(/non-hex/);
  });
});
