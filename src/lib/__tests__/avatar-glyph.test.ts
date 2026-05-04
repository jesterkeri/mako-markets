// ----------------------------------------------------------------------------
// avatar-glyph.test.ts
//
// Pure-logic tests for the AvatarCircle helpers extracted into
// src/lib/avatar-glyph.ts. Pins:
//   - initials prefer displayName (trimmed) over email over 'M'
//   - palette index is deterministic: same EOA → same index
//   - palette index varies across distinct EOAs
//   - palette is the static class-literal array (Tailwind purger
//     visibility — codex round-1 NIT 2)
// ----------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import {
  STATIC_PALETTE,
  deriveInitial,
  derivePaletteIndex,
} from '../avatar-glyph';

describe('STATIC_PALETTE', () => {
  it('contains six entries with literal Tailwind class strings', () => {
    expect(STATIC_PALETTE.length).toBe(6);
    for (const entry of STATIC_PALETTE) {
      // Class names must NOT be runtime-built — they have to appear
      // verbatim in source for Tailwind's content scanner.
      expect(entry.bg).toMatch(/^bg-mako-/);
      expect(entry.fg).toMatch(/^text-/);
    }
  });
});

describe('deriveInitial', () => {
  it('uses the first character of displayName when present', () => {
    expect(deriveInitial('Joshua', 'a@b.com')).toBe('J');
  });

  it('trims whitespace before taking the first character', () => {
    expect(deriveInitial('  Joshua', 'a@b.com')).toBe('J');
    expect(deriveInitial('\tJoshua', 'a@b.com')).toBe('J');
  });

  it('falls through to email when displayName is null', () => {
    expect(deriveInitial(null, 'alice@example.com')).toBe('A');
  });

  it('falls through to email when displayName is whitespace only', () => {
    expect(deriveInitial('   ', 'bob@example.com')).toBe('B');
  });

  it('falls through to email when displayName is empty string', () => {
    expect(deriveInitial('', 'carol@example.com')).toBe('C');
  });

  it('returns "M" when both displayName and email are unusable', () => {
    expect(deriveInitial(null, '')).toBe('M');
    expect(deriveInitial('', '')).toBe('M');
  });

  it('uppercases the resulting initial', () => {
    expect(deriveInitial('joshua', 'a@b.com')).toBe('J');
    expect(deriveInitial(null, 'alice@b.com')).toBe('A');
  });

  it('handles single-letter inputs', () => {
    expect(deriveInitial('z', 'a@b.com')).toBe('Z');
  });
});

describe('derivePaletteIndex', () => {
  it('returns the same index for the same EOA across calls', () => {
    const eoa = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    expect(derivePaletteIndex(eoa)).toBe(derivePaletteIndex(eoa));
  });

  it('returns an index in [0, palette.length)', () => {
    for (const eoa of [
      '0x0000000000000000000000000000000000000000',
      '0xffffffffffffffffffffffffffffffffffffffff',
      '0xabcdef1234567890abcdef1234567890abcdef12',
    ]) {
      const idx = derivePaletteIndex(eoa);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(STATIC_PALETTE.length);
    }
  });

  it('produces multiple distinct indices across a sample of EOAs', () => {
    const samples = [
      '0x0000000000000000000000000000000000000000',
      '0x1111111111111111111111111111111111111111',
      '0x2222222222222222222222222222222222222222',
      '0xabcdef1234567890abcdef1234567890abcdef12',
      '0xfedcba0987654321fedcba0987654321fedcba09',
      '0x9999999999999999999999999999999999999999',
      '0xaabbccddeeff00112233445566778899aabbccdd',
      '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      '0x1234567890123456789012345678901234567890',
      '0xcafebabecafebabecafebabecafebabecafebabe',
    ];
    const indices = new Set(samples.map(derivePaletteIndex));
    // With 10 samples across 6 buckets we expect at least 3 distinct
    // hits in practice. The test fails if the function gets stuck
    // returning the same index for everyone.
    expect(indices.size).toBeGreaterThanOrEqual(3);
  });

  it('handles EOAs without the 0x prefix', () => {
    const idx = derivePaletteIndex('aaaaa1234');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(STATIC_PALETTE.length);
  });
});
