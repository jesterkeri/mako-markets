// applyEmbeddedMove's guards live in its SQL WHERE clause: it binds and moves an account only while the account
// has no Privy user AND its signer is still the one read. Those guards are what stop two concurrent sign-ins
// from both moving an account, so the test compiles the real WHERE clause and checks both are there.

import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

vi.mock('server-only', () => ({}));
vi.mock('@/db/client', () => ({ db: {} }));

import { applyEmbeddedMove } from '../user-upsert';

function captureWhere() {
  let where: SQL | undefined;
  const tx = {
    update: () => ({
      set: () => ({
        where: (w: SQL) => {
          where = w;
          return { returning: async () => [] };
        },
      }),
    }),
  };
  return { tx, get: () => where };
}

describe('applyEmbeddedMove guards', () => {
  it('moves only an unbound account whose signer is still the one read', async () => {
    const c = captureWhere();
    const res = await applyEmbeddedMove(c.tx as never, {
      userId: 'user-1',
      from: '0x' + 'a'.repeat(40),
      to: '0x' + 'b'.repeat(40),
      privyUserId: 'did:privy:u1',
    });
    expect(res).toBeNull(); // no row matched: nothing else happens
    const { sql, params } = new PgDialect().sqlToQuery(c.get()!);
    expect(sql).toMatch(/"privy_user_id" is null/);
    expect(sql).toMatch(/"magic_eoa" = \$\d/);
    expect(params).toContain('0x' + 'a'.repeat(40));
    expect(params).toContain('user-1');
  });
});
