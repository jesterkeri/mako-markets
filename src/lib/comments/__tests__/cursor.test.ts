// ----------------------------------------------------------------------------
// src/lib/comments/__tests__/cursor.test.ts
//
// The keyset cursor is attacker-supplied. decodeCursor must round-trip a valid
// cursor and return null (→ route 400) on ANYTHING malformed — never a partial
// value that reaches SQL.
// ----------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { decodeCursor, encodeCursor } from '../cursor';

const ID = '11111111-2222-4333-8444-555555555555';

describe('cursor round-trip', () => {
  it('encodes then decodes to the same (createdAt, id)', () => {
    const createdAt = new Date('2026-07-04T12:34:56.789Z');
    const token = encodeCursor({ createdAt, id: ID });
    const back = decodeCursor(token);
    expect(back).not.toBeNull();
    expect(back!.id).toBe(ID);
    expect(back!.createdAt.toISOString()).toBe(createdAt.toISOString());
  });
});

describe('decodeCursor rejects malformed input', () => {
  it('returns null on non-base64 / non-JSON', () => {
    expect(decodeCursor('')).toBeNull();
    expect(decodeCursor('!!!!')).toBeNull();
    expect(decodeCursor('bm90IGpzb24')).toBeNull(); // base64("not json")
  });
  it('returns null on wrong shape or bad field types', () => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
    expect(decodeCursor(enc({}))).toBeNull();
    expect(decodeCursor(enc({ t: 123, id: ID }))).toBeNull();
    expect(decodeCursor(enc({ t: '2026-07-04T12:34:56.789Z' }))).toBeNull();
    expect(decodeCursor(enc({ t: '2026-07-04T12:34:56.789Z', id: 'not-uuid' }))).toBeNull();
  });
  it('returns null on an invalid or non-canonical timestamp', () => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
    expect(decodeCursor(enc({ t: 'not-a-date', id: ID }))).toBeNull();
    // loosely-formatted but Date-parseable → rejected by the round-trip guard
    expect(decodeCursor(enc({ t: '2026-1-1', id: ID }))).toBeNull();
  });
});
