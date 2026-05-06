// ----------------------------------------------------------------------------
// last-sign-in.test.ts
//
// Unit tests for `readLastSignIn`. Mocks the Drizzle SELECT chain so we
// can assert two things:
//   1. The WHERE clause includes a `ne(sessions.id, excludeSessionId)`
//      predicate when `excludeSessionId` is non-null, and excludes that
//      predicate when null. This is the load-bearing /me-vs-auth-route
//      distinction.
//   2. Returns the existing row's createdAt as ISO-8601 string, or null
//      when no rows match.
//
// We don't unit-test the SQL ordering or the limit value — those are
// trivial and would just re-assert the call shape. The real correctness
// guarantee is at integration time (a Postgres with index on user_id).
// ----------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rows: vi.fn(),
  whereSpy: vi.fn(),
  andSpy: vi.fn(),
  eqSpy: vi.fn(),
  neSpy: vi.fn(),
  descSpy: vi.fn(),
}));

vi.mock('@/db/schema', () => ({
  sessions: {
    id: 'sessions.id',
    userId: 'sessions.user_id',
    createdAt: 'sessions.created_at',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => {
    mocks.andSpy(...args);
    return { and: args };
  },
  eq: (a: unknown, b: unknown) => {
    mocks.eqSpy(a, b);
    return { eq: [a, b] };
  },
  ne: (a: unknown, b: unknown) => {
    mocks.neSpy(a, b);
    return { ne: [a, b] };
  },
  desc: (a: unknown) => {
    mocks.descSpy(a);
    return { desc: a };
  },
}));

vi.mock('@/db/client', () => {
  const limit = () => mocks.rows();
  const orderBy = () => ({ limit });
  const where = (clause: unknown) => {
    mocks.whereSpy(clause);
    return { orderBy };
  };
  const from = () => ({ where });
  const select = () => ({ from });
  return { db: { select } };
});

afterEach(() => {
  vi.clearAllMocks();
});

const USER_ID = '00000000-0000-0000-0000-0000000000aa';
const SESSION_ID = '00000000-0000-0000-0000-0000000000bb';

describe('readLastSignIn', () => {
  it('returns ISO timestamp when a prior session exists', async () => {
    const ts = new Date('2026-04-01T12:34:56.000Z');
    mocks.rows.mockResolvedValue([{ createdAt: ts }]);

    const { readLastSignIn } = await import('../last-sign-in');
    const got = await readLastSignIn(USER_ID, null);

    expect(got).toBe('2026-04-01T12:34:56.000Z');
  });

  it('returns null when no prior session exists', async () => {
    mocks.rows.mockResolvedValue([]);

    const { readLastSignIn } = await import('../last-sign-in');
    const got = await readLastSignIn(USER_ID, null);

    expect(got).toBeNull();
  });

  it('omits the ne(sessions.id, ...) predicate when excludeSessionId is null', async () => {
    mocks.rows.mockResolvedValue([]);

    const { readLastSignIn } = await import('../last-sign-in');
    await readLastSignIn(USER_ID, null);

    expect(mocks.neSpy).not.toHaveBeenCalled();
    expect(mocks.eqSpy).toHaveBeenCalledWith('sessions.user_id', USER_ID);
    // No `and()` because there's only one predicate.
    expect(mocks.andSpy).not.toHaveBeenCalled();
  });

  it('includes the ne(sessions.id, currentSession) predicate when excludeSessionId is set', async () => {
    mocks.rows.mockResolvedValue([]);

    const { readLastSignIn } = await import('../last-sign-in');
    await readLastSignIn(USER_ID, SESSION_ID);

    expect(mocks.neSpy).toHaveBeenCalledWith('sessions.id', SESSION_ID);
    expect(mocks.eqSpy).toHaveBeenCalledWith('sessions.user_id', USER_ID);
    expect(mocks.andSpy).toHaveBeenCalledTimes(1);
  });

  it('uses the provided tx writer when one is passed', async () => {
    const txLimit = vi.fn().mockResolvedValue([
      { createdAt: new Date('2026-03-15T00:00:00.000Z') },
    ]);
    const txOrderBy = vi.fn().mockReturnValue({ limit: txLimit });
    const txWhere = vi.fn().mockReturnValue({ orderBy: txOrderBy });
    const txFrom = vi.fn().mockReturnValue({ where: txWhere });
    const txSelect = vi.fn().mockReturnValue({ from: txFrom });
    const tx = { select: txSelect } as unknown as Parameters<
      typeof import('../last-sign-in')['readLastSignIn']
    >[2] extends infer T
      ? T extends { tx?: infer X }
        ? NonNullable<X>
        : never
      : never;

    const { readLastSignIn } = await import('../last-sign-in');
    const got = await readLastSignIn(USER_ID, null, { tx });

    expect(got).toBe('2026-03-15T00:00:00.000Z');
    expect(txSelect).toHaveBeenCalledOnce();
    // The default `db.select` was NOT used because tx took precedence.
    expect(mocks.rows).not.toHaveBeenCalled();
  });
});
