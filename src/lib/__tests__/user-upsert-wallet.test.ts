// ----------------------------------------------------------------------------
// user-upsert-wallet.test.ts
//
// Unit-level tests for `upsertWalletUser`. The codebase doesn't have a DB
// integration harness; we mock the tx client and assert the helper's
// boundary contract:
//
//   1. Lowercase canonicalization happens BEFORE the SQL is issued so that
//      'wallet_address = lower(wallet_address)' (the DB CHECK) cannot fail.
//   2. EVM-format assertion rejects non-hex / wrong-length inputs.
//   3. The INSERT ... ON CONFLICT path returns the inserted row (id +
//      displayName + avatarUrl).
//   4. The fallback SELECT path returns the existing row when ON CONFLICT
//      DO NOTHING skips.
//   5. The "row missing after ON CONFLICT" guard fires if both paths return
//      empty (programmer-error / committed-then-deleted edge case).
//
// Concurrent-race testing (two Promise.all upserts on the same address
// resolve to ONE row) requires a real Postgres — covered by a deferred
// integration test, NOT this unit suite. The DB partial unique index +
// the ON CONFLICT WHERE predicate are what guarantee race-safety; the
// helper just hands them to the database.
// ----------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest';

import { upsertWalletUser } from '../user-upsert';

const ADDR = '0x1234567890abcdef1234567890abcdef12345678';
const ADDR_MIXED = '0x1234567890ABCDEF1234567890abcdef12345678';

// Drizzle's postgres-js driver returns a `RowList<T[]>` from
// `tx.execute<T>(sql)` — that is an array directly, NOT a `{ rows: [...] }`
// wrapper. The previous mock shape (`{ rows }`) caused codex round-6
// MAJOR: every production wallet auth call would hit `inserted.rows ===
// undefined` and throw, while the test's wrong mock said it was fine.
type InsertedRow = {
  id: string;
  display_name: string | null;
  avatar_url: string | null;
};

type SelectChain = {
  from: () => {
    where: () => {
      limit: () => Promise<Array<{
        id: string;
        displayName: string | null;
        avatarUrl: string | null;
      }>>;
    };
  };
};

function makeTx(opts: {
  insertResult: InsertedRow[];
  selectResult?: Array<{ id: string; displayName: string | null; avatarUrl: string | null }>;
}) {
  const execute = vi.fn().mockResolvedValue(opts.insertResult);
  const limit = vi.fn().mockResolvedValue(opts.selectResult ?? []);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from } as unknown as SelectChain);
  return {
    tx: { execute, select } as unknown as Parameters<typeof upsertWalletUser>[1]['tx'],
    spies: { execute, select, from, where, limit },
  };
}

describe('upsertWalletUser', () => {
  it('returns inserted row on first-write (ON CONFLICT did not fire)', async () => {
    const { tx, spies } = makeTx({
      insertResult: [{ id: 'u1', display_name: null, avatar_url: null }],
    });

    const out = await upsertWalletUser(ADDR, { tx });

    expect(out).toEqual({ id: 'u1', displayName: null, avatarUrl: null });
    expect(spies.execute).toHaveBeenCalledOnce();
    expect(spies.select).not.toHaveBeenCalled();
  });

  it('falls back to SELECT when ON CONFLICT DO NOTHING skipped the insert', async () => {
    const { tx, spies } = makeTx({
      insertResult: [],
      selectResult: [{ id: 'u2', displayName: 'alice', avatarUrl: null }],
    });

    const out = await upsertWalletUser(ADDR, { tx });

    expect(out).toEqual({ id: 'u2', displayName: 'alice', avatarUrl: null });
    expect(spies.execute).toHaveBeenCalledOnce();
    expect(spies.select).toHaveBeenCalledOnce();
  });

  it('throws when both INSERT and SELECT return empty (committed-then-deleted)', async () => {
    const { tx } = makeTx({
      insertResult: [],
      selectResult: [],
    });

    await expect(upsertWalletUser(ADDR, { tx })).rejects.toThrow(
      /row missing after ON CONFLICT/,
    );
  });

  it('lowercases mixed-case input before issuing SQL', async () => {
    const { tx, spies } = makeTx({
      insertResult: [{ id: 'u3', display_name: null, avatar_url: null }],
    });

    await upsertWalletUser(ADDR_MIXED, { tx });

    // Drizzle's sql template tag is invoked with a Sql object whose
    // queryChunks hold the interpolated values literally. We assert that
    // the lowercased address appears verbatim and that the original
    // mixed-case string does NOT.
    const callArg = spies.execute.mock.calls[0][0];
    const serialized = JSON.stringify(callArg);
    expect(serialized).toContain(ADDR);
    expect(serialized).not.toContain(ADDR_MIXED);
  });

  it('records a valid campaign tag on the account it creates, and drops an invalid one', async () => {
    const valid = makeTx({ insertResult: [{ id: 'u4', display_name: null, avatar_url: null }] });
    await upsertWalletUser(ADDR, { tx: valid.tx, ref: 'Post3' });
    const sent = JSON.stringify(valid.spies.execute.mock.calls[0][0]);
    expect(sent).toContain('INSERT INTO users (wallet_address, auth_type, ref)');
    expect(sent).toContain('"post3"');

    const invalid = makeTx({ insertResult: [{ id: 'u5', display_name: null, avatar_url: null }] });
    await upsertWalletUser(ADDR, { tx: invalid.tx, ref: "x'; drop table users;--" });
    const sentInvalid = JSON.stringify(invalid.spies.execute.mock.calls[0][0]);
    expect(sentInvalid).not.toContain('drop table');
    expect(sentInvalid).toContain('null');
  });

  it('rejects non-EVM-format input before any SQL is issued', async () => {
    const { tx, spies } = makeTx({
      insertResult: [],
    });

    await expect(
      upsertWalletUser('0xnot-an-address' as `0x${string}`, { tx }),
    ).rejects.toThrow(/invalid address format/);
    await expect(
      upsertWalletUser('0x1234' as `0x${string}`, { tx }),
    ).rejects.toThrow(/invalid address format/);
    await expect(
      upsertWalletUser(
        '0x1234567890abcdef1234567890abcdef1234567g' as `0x${string}`,
        { tx },
      ),
    ).rejects.toThrow(/invalid address format/);
    expect(spies.execute).not.toHaveBeenCalled();
  });
});
