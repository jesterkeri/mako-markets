// ----------------------------------------------------------------------------
// src/lib/private-markets/__tests__/normalize.test.ts
//
// Coverage for the chain↔DB conversion helpers in normalize.ts. Every
// pm_* schema CHECK constraint depends on these producing canonical
// values; every viem RPC site depends on the bigint↔number boundaries
// failing loud rather than silently truncating. These are the unit
// tests that catch a refactor that breaks either contract.
//
// Handler / orchestrator / query tests are integration-level (real
// Postgres + viem mock); they live in the manual smoke procedure for
// 2B-2 (see the plan at %TEMP%/mako-private-markets-2B-2-plan.md).
// ----------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import {
  normalizeHex,
  bigintToNumber,
  numberToBigInt,
  secondsBigIntToDate,
  bytesToUtf8,
  mapShapeEnum,
} from '../normalize';

describe('normalizeHex', () => {
  it('lowercases a checksummed 20-byte address', () => {
    expect(
      normalizeHex('0xC9c6575a14D0e84afd5AB21C506916Fd2864bb8f', 20),
    ).toBe('0xc9c6575a14d0e84afd5ab21c506916fd2864bb8f');
  });

  it('passes through an already-lowercase address', () => {
    expect(
      normalizeHex('0xabcdef0123456789abcdef0123456789abcdef01', 20),
    ).toBe('0xabcdef0123456789abcdef0123456789abcdef01');
  });

  it('lowercases a checksummed 32-byte hash', () => {
    expect(
      normalizeHex(
        '0xABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789',
        32,
      ),
    ).toBe(
      '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
    );
  });

  it('throws on length mismatch (20-byte expected, 32-byte given)', () => {
    expect(() =>
      normalizeHex(
        '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789' as `0x${string}`,
        20,
      ),
    ).toThrow(/expected 42 chars/);
  });

  it('throws on missing 0x prefix', () => {
    // Cast through unknown to bypass the type check — the function's
    // runtime guard is what we're exercising.
    expect(() =>
      normalizeHex(
        'abcdef0123456789abcdef0123456789abcdef01' as unknown as `0x${string}`,
        20,
      ),
    ).toThrow(/0x-prefixed/);
  });

  it('throws on non-hex characters', () => {
    expect(() =>
      normalizeHex('0xZZcdef0123456789abcdef0123456789abcdef01', 20),
    ).toThrow(/invalid hex/);
  });
});

describe('bigintToNumber', () => {
  it('converts 0n', () => {
    expect(bigintToNumber(0n)).toBe(0);
  });

  it('converts MAX_SAFE_INTEGER', () => {
    expect(bigintToNumber(BigInt(Number.MAX_SAFE_INTEGER))).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it('throws above MAX_SAFE_INTEGER', () => {
    expect(() =>
      bigintToNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n),
    ).toThrow(/safe-integer range/);
  });

  it('throws on 2n ** 60n (chain marketId overflow guard)', () => {
    expect(() => bigintToNumber(2n ** 60n)).toThrow(/safe-integer range/);
  });

  it('throws on negative', () => {
    expect(() => bigintToNumber(-1n)).toThrow(/safe-integer range/);
  });
});

describe('numberToBigInt', () => {
  it('converts 0', () => {
    expect(numberToBigInt(0)).toBe(0n);
  });

  it('converts MAX_SAFE_INTEGER', () => {
    expect(numberToBigInt(Number.MAX_SAFE_INTEGER)).toBe(
      BigInt(Number.MAX_SAFE_INTEGER),
    );
  });

  it('throws above MAX_SAFE_INTEGER', () => {
    expect(() => numberToBigInt(Number.MAX_SAFE_INTEGER + 1)).toThrow(
      /non-negative safe integer/,
    );
  });

  it('throws on negative', () => {
    expect(() => numberToBigInt(-1)).toThrow(/non-negative safe integer/);
  });

  it('throws on non-integer', () => {
    expect(() => numberToBigInt(1.5)).toThrow(/non-negative safe integer/);
  });
});

describe('secondsBigIntToDate', () => {
  it('converts 0n to epoch', () => {
    expect(secondsBigIntToDate(0n).toISOString()).toBe(
      '1970-01-01T00:00:00.000Z',
    );
  });

  it('converts a typical block.timestamp seconds value', () => {
    // 2026-05-12T00:00:00Z = 1778544000
    expect(secondsBigIntToDate(1778544000n).toISOString()).toBe(
      '2026-05-12T00:00:00.000Z',
    );
  });

  it('throws on negative', () => {
    expect(() => secondsBigIntToDate(-1n)).toThrow(/negative timestamp/);
  });

  it('throws on overflow of JS Date max', () => {
    // 8_640_000_000_000 seconds + 1 = past JS Date max
    expect(() =>
      secondsBigIntToDate(8_640_000_000_001n),
    ).toThrow(/JS Date range/);
  });
});

describe('bytesToUtf8', () => {
  it('decodes a typical UTF-8 string', () => {
    // "hello" = 0x68656c6c6f
    expect(bytesToUtf8('0x68656c6c6f')).toEqual({
      value: 'hello',
      ok: true,
    });
  });

  it('decodes unicode characters', () => {
    // "Mako Markét" — UTF-8 bytes
    const utf8 = new TextEncoder().encode('Mako Markét');
    const hex =
      '0x' +
      Array.from(utf8)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    expect(bytesToUtf8(hex as `0x${string}`)).toEqual({
      value: 'Mako Markét',
      ok: true,
    });
  });

  it('returns ok:true for empty bytes', () => {
    expect(bytesToUtf8('0x')).toEqual({ value: '', ok: true });
  });

  it('falls back to lowercase hex for invalid UTF-8', () => {
    // 0xFF is not valid UTF-8 on its own.
    const result = bytesToUtf8('0xFF');
    expect(result.ok).toBe(false);
    expect(result.value).toBe('0xff');
  });

  it('falls back to lowercase hex for malformed hex (odd length)', () => {
    const result = bytesToUtf8('0xabc' as `0x${string}`);
    expect(result.ok).toBe(false);
  });
});

describe('mapShapeEnum', () => {
  it('maps 0 → friendly', () => {
    expect(mapShapeEnum(0)).toBe('friendly');
  });

  it('maps 1 → open_vote', () => {
    expect(mapShapeEnum(1)).toBe('open_vote');
  });

  it('maps 2 → prize_pool', () => {
    expect(mapShapeEnum(2)).toBe('prize_pool');
  });

  it('throws on unknown enum value', () => {
    expect(() => mapShapeEnum(3)).toThrow(/unknown shape/);
    expect(() => mapShapeEnum(255)).toThrow(/unknown shape/);
  });
});
