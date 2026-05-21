// ----------------------------------------------------------------------------
// src/lib/__tests__/mako-labels.test.ts
//
// Unit tests for the pure validator in mako-labels.ts. No DB, no network —
// just the rule that powers the admin form, the API zod schema, and (by
// indirect mirroring) the SQL CHECK constraint.
// ----------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import {
  MAKO_LABEL_MAX_BYTES,
  utf8ByteLength,
  validateLabelPair,
} from '@/lib/mako-labels';

describe('utf8ByteLength', () => {
  it('counts ASCII as 1 byte per char', () => {
    expect(utf8ByteLength('APC')).toBe(3);
    expect(utf8ByteLength('')).toBe(0);
  });

  it('counts non-ASCII as multi-byte', () => {
    // "é" is 2 bytes in UTF-8
    expect(utf8ByteLength('é')).toBe(2);
    // emoji are 4 bytes
    expect(utf8ByteLength('🦈')).toBe(4);
  });

  it('matches MAKO_LABEL_MAX_BYTES at exactly 32 ASCII chars', () => {
    const s = 'a'.repeat(MAKO_LABEL_MAX_BYTES);
    expect(utf8ByteLength(s)).toBe(MAKO_LABEL_MAX_BYTES);
  });
});

describe('validateLabelPair', () => {
  it('accepts both filled within cap', () => {
    expect(validateLabelPair('APC', 'PDP')).toEqual({
      ok: true,
      mode: 'filled',
    });
  });

  it('accepts both empty (fallback to YES/NO at render)', () => {
    expect(validateLabelPair('', '')).toEqual({ ok: true, mode: 'empty' });
  });

  it('treats whitespace-only as empty', () => {
    expect(validateLabelPair('   ', '\t\n')).toEqual({
      ok: true,
      mode: 'empty',
    });
  });

  it('rejects label1 filled + label2 empty', () => {
    expect(validateLabelPair('APC', '')).toEqual({
      ok: false,
      reason: 'mixed_empty',
    });
  });

  it('rejects label1 empty + label2 filled', () => {
    expect(validateLabelPair('', 'PDP')).toEqual({
      ok: false,
      reason: 'mixed_empty',
    });
  });

  it('rejects label1 over byte cap', () => {
    const over = 'a'.repeat(MAKO_LABEL_MAX_BYTES + 1);
    expect(validateLabelPair(over, 'PDP')).toEqual({
      ok: false,
      reason: 'label1_too_long',
    });
  });

  it('rejects label2 over byte cap', () => {
    const over = 'b'.repeat(MAKO_LABEL_MAX_BYTES + 1);
    expect(validateLabelPair('APC', over)).toEqual({
      ok: false,
      reason: 'label2_too_long',
    });
  });

  it('accepts labels exactly at the cap', () => {
    const at = 'x'.repeat(MAKO_LABEL_MAX_BYTES);
    expect(validateLabelPair(at, at)).toEqual({
      ok: true,
      mode: 'filled',
    });
  });

  it('catches non-ASCII over the byte cap even when char-count looks safe', () => {
    // 11 emoji * 4 bytes = 44 bytes (over the 32 cap) but 11 chars
    const heavy = '🦈'.repeat(11);
    expect(utf8ByteLength(heavy)).toBe(44);
    expect(validateLabelPair(heavy, 'PDP')).toEqual({
      ok: false,
      reason: 'label1_too_long',
    });
  });

  it('accepts non-ASCII within the byte cap', () => {
    // 4 emoji * 4 bytes = 16 bytes, well under 32
    const fits = '🦈'.repeat(4);
    expect(validateLabelPair(fits, 'PDP')).toEqual({
      ok: true,
      mode: 'filled',
    });
  });
});
