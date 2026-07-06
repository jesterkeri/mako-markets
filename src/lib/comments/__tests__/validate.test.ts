// ----------------------------------------------------------------------------
// src/lib/comments/__tests__/validate.test.ts
//
// Pure-validator unit tests. These are the input-hardening trust boundary for
// POST /api/comments — every bad case here is a 400 the route must produce.
// ----------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import {
  bodyByteLength,
  clampLimit,
  isCanonicalUint256,
  isUuid,
  isValidSlug,
  parsePostBody,
  validateBody,
} from '../validate';

const UUID = '11111111-2222-4333-8444-555555555555';
const MAX_UINT256 =
  '115792089237316195423570985008687907853269984665640564039457584007913129639935';

describe('bodyByteLength', () => {
  it('counts ASCII as 1 byte and multibyte by UTF-8 length', () => {
    expect(bodyByteLength('abc')).toBe(3);
    expect(bodyByteLength('✓')).toBe(3); // U+2713 is 3 bytes
    expect(bodyByteLength('✓✓')).toBe(6);
  });
});

describe('isCanonicalUint256', () => {
  it('accepts canonical decimals incl. 0 and 2^256-1', () => {
    expect(isCanonicalUint256('0')).toBe(true);
    expect(isCanonicalUint256('5')).toBe(true);
    expect(isCanonicalUint256(MAX_UINT256)).toBe(true);
  });
  it('rejects leading zeros, empties, non-digits, whitespace', () => {
    expect(isCanonicalUint256('00')).toBe(false);
    expect(isCanonicalUint256('01')).toBe(false);
    expect(isCanonicalUint256('')).toBe(false);
    expect(isCanonicalUint256('abc')).toBe(false);
    expect(isCanonicalUint256(' 5')).toBe(false);
    expect(isCanonicalUint256('5 ')).toBe(false);
    expect(isCanonicalUint256('-1')).toBe(false);
    expect(isCanonicalUint256('1.0')).toBe(false);
  });
  it('rejects > 2^256-1 and overlong strings without a huge BigInt parse', () => {
    expect(isCanonicalUint256((BigInt(MAX_UINT256) + 1n).toString())).toBe(false);
    expect(isCanonicalUint256('9'.repeat(79))).toBe(false); // 79 digits > 78 cap
  });
});

describe('isUuid / isValidSlug', () => {
  it('validates uuids', () => {
    expect(isUuid(UUID)).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid('11111111222243338444555555555555')).toBe(false);
  });
  it('validates slugs (bare + dx-)', () => {
    expect(isValidSlug('8x3k9p2v')).toBe(true);
    expect(isValidSlug('dx-8x3k9p2v')).toBe(true);
    expect(isValidSlug('short')).toBe(false);
    expect(isValidSlug('8x3k9p2v!')).toBe(false);
    expect(isValidSlug('dx-short')).toBe(false);
  });
});

describe('validateBody', () => {
  it('accepts a trimmed 1..2000-byte body', () => {
    expect(validateBody('  hi  ')).toEqual({ body: 'hi' });
    expect(validateBody('a'.repeat(2000))).toEqual({ body: 'a'.repeat(2000) });
  });
  it('rejects empty, whitespace-only, oversize, and multibyte-oversize', () => {
    expect(validateBody('')).toEqual({ error: 'bad_body' });
    expect(validateBody('   ')).toEqual({ error: 'bad_body' });
    expect(validateBody('a'.repeat(2001))).toEqual({ error: 'bad_body' });
    // 700 * 3 bytes = 2100 > 2000, though only 700 chars
    expect(validateBody('✓'.repeat(700))).toEqual({ error: 'bad_body' });
    expect(validateBody(123 as unknown)).toEqual({ error: 'bad_body' });
  });
});

describe('parsePostBody', () => {
  it('accepts a well-formed main comment', () => {
    expect(parsePostBody({ scope: 'main', marketId: '5', body: 'hi' })).toEqual({
      scope: 'main',
      marketId: '5',
      parentId: null,
      body: 'hi',
    });
  });
  it('accepts a well-formed pm reply', () => {
    expect(
      parsePostBody({ scope: 'pm', slug: '8x3k9p2v', parentId: UUID, body: 'yo' }),
    ).toEqual({ scope: 'pm', slug: '8x3k9p2v', parentId: UUID, body: 'yo' });
  });
  it('treats absent and explicit-null parentId as top-level', () => {
    const a = parsePostBody({ scope: 'main', marketId: '1', body: 'x' });
    const b = parsePostBody({ scope: 'main', marketId: '1', parentId: null, body: 'x' });
    expect(a).toMatchObject({ parentId: null });
    expect(b).toMatchObject({ parentId: null });
  });
  it('REJECTS unknown keys (not ignore — comments differ from profile route)', () => {
    expect(
      parsePostBody({ scope: 'main', marketId: '1', body: 'x', userId: 'evil' }),
    ).toEqual({ error: 'unknown_key' });
    // a main-scope body may not carry the pm target key
    expect(
      parsePostBody({ scope: 'main', marketId: '1', slug: '8x3k9p2v', body: 'x' }),
    ).toEqual({ error: 'unknown_key' });
  });
  it('rejects bad scope / target / parent / body', () => {
    expect(parsePostBody({ scope: 'other', marketId: '1', body: 'x' })).toEqual({
      error: 'bad_scope',
    });
    expect(parsePostBody({ scope: 'main', marketId: '01', body: 'x' })).toEqual({
      error: 'bad_market_id',
    });
    expect(parsePostBody({ scope: 'main', body: 'x' })).toEqual({
      error: 'bad_market_id',
    });
    expect(parsePostBody({ scope: 'pm', slug: 'nope!', body: 'x' })).toEqual({
      error: 'bad_slug',
    });
    expect(
      parsePostBody({ scope: 'main', marketId: '1', parentId: 'not-uuid', body: 'x' }),
    ).toEqual({ error: 'bad_parent' });
    expect(parsePostBody({ scope: 'main', marketId: '1', body: '' })).toEqual({
      error: 'bad_body',
    });
  });
  it('rejects non-object / array bodies', () => {
    expect(parsePostBody(null)).toEqual({ error: 'bad_body' });
    expect(parsePostBody([])).toEqual({ error: 'bad_body' });
    expect(parsePostBody('str')).toEqual({ error: 'bad_body' });
  });
});

describe('clampLimit', () => {
  it('clamps into [1,max], falls back to default on junk', () => {
    expect(clampLimit(null, 30, 50)).toBe(30);
    expect(clampLimit('10', 30, 50)).toBe(10);
    expect(clampLimit('10000', 30, 50)).toBe(50);
    expect(clampLimit('0', 30, 50)).toBe(30);
    expect(clampLimit('-5', 30, 50)).toBe(30);
    expect(clampLimit('abc', 30, 50)).toBe(30);
    expect(clampLimit('25', 30, 50)).toBe(25);
    expect(clampLimit('1.5', 30, 50)).toBe(30);
  });
});
