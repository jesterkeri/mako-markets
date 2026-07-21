import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { emailChangeCooldownWhere } from '@/app/api/user/email/update/cooldown-where';

// #192 regression suite: every server-side timestamp comparison must bind its
// cutoff as an ISO string, NOT a raw JS Date. postgres-js with `prepare: false`
// (Neon's pooled path) throws `ERR_INVALID_ARG_TYPE` ("Received an instance of
// Date") on a raw Date bind in a `sql` template — which silently broke the
// aa-fast/aa-slow cron sweeps (since 2026-06-12) and would crash the email-change
// UPDATE. pglite accepts Dates, so behavioral integration tests can't catch it;
// we assert the bound param TYPE at the SQL-generation layer. (Drizzle operators
// like lt/eq are safe — they attach the column encoder; only raw `sql`
// interpolation lacks it, which is the failing pattern.)

const captured = vi.hoisted(() => ({ where: undefined as unknown }));

// Minimal fake db: the sweep fns call db.select().from().where().limit(). We
// capture the WHERE condition and short-circuit .limit() to an empty result.
vi.mock('@/db/client', () => {
  const builder = {
    from: () => builder,
    where: (cond: unknown) => {
      captured.where = cond;
      return builder;
    },
    limit: () => Promise.resolve([]),
  };
  return { db: { select: () => builder }, schema: {} };
});

const dialect = new PgDialect();
const noDates = (params: unknown[]) => params.every((p) => !(p instanceof Date));
const hasIsoString = (params: unknown[]) =>
  params.some((p) => typeof p === 'string' && /^\d{4}-\d\d-\d\dT/.test(p));

describe('#192 aa-fast/aa-slow sweep cutoff binds as ISO string, not Date', () => {
  beforeEach(() => {
    captured.where = undefined;
  });

  it('selectStaleSendingRows binds the sendingStartedAt cutoff as a string', async () => {
    const { selectStaleSendingRows } = await import('@/lib/aa-pending-user-ops');
    await selectStaleSendingRows({ thresholdMs: 5 * 60_000, limit: 50 });
    const { params } = dialect.sqlToQuery(captured.where as SQL);
    // The regression: a raw Date bind would appear here as a Date instance.
    expect(noDates(params)).toBe(true);
    expect(hasIsoString(params)).toBe(true);
  });

  it('selectStaleSubmittedRows binds the statusUpdatedAt cutoff as a string', async () => {
    const { selectStaleSubmittedRows } = await import('@/lib/aa-pending-user-ops');
    await selectStaleSubmittedRows({ thresholdMs: 5 * 60_000, limit: 50 });
    const { params } = dialect.sqlToQuery(captured.where as SQL);
    expect(noDates(params)).toBe(true);
    expect(hasIsoString(params)).toBe(true);
  });
});

describe('#192 email-change cooldown WHERE binds the cutoff as a string, not Date', () => {
  it('emailChangeCooldownWhere binds oneYearAgo as a string', () => {
    const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const cond = emailChangeCooldownWhere(
      '00000000-0000-0000-0000-000000000000',
      '0xABCabcABCabcABCabcABCabcABCabcABCabcABCa',
      oneYearAgo,
    );
    const { params } = dialect.sqlToQuery(cond as SQL);
    expect(noDates(params)).toBe(true);
    expect(hasIsoString(params)).toBe(true);
  });
});
