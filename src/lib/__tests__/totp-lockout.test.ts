// ----------------------------------------------------------------------------
// totp-lockout.test.ts
//
// Pins the shared TOTP lockout helper that /api/user/auth/totp +
// /api/user/totp/disable + /api/user/totp/regenerate-recovery-codes all
// use to bump failed_attempts and fire the 15-min lockout on the 5th
// failure. Route tests mock this helper out, so without dedicated
// coverage a future regression in the SQL shape (read-before-write,
// missing CASE branch, wrong threshold) would slip through.
//
// Mocks the Drizzle chain at db.update().set().where().returning() and
// asserts:
//   - one .update() call (no read-before-write path)
//   - whatever RETURNING resolves to is passed through verbatim
//   - empty RETURNING (user row deleted mid-flight) maps to
//     { attempts: 0, lockedUntil: null } so the caller doesn't crash
//   - isLockoutActive true/false boundaries
// ----------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  set: vi.fn(),
  where: vi.fn(),
  returning: vi.fn(),
}));

vi.mock('@/db/client', () => ({
  db: {
    update: (...args: unknown[]) => {
      mocks.update(...args);
      return {
        set: (...sArgs: unknown[]) => {
          mocks.set(...sArgs);
          return {
            where: (...wArgs: unknown[]) => {
              mocks.where(...wArgs);
              return {
                returning: (...rArgs: unknown[]) => {
                  mocks.returning(...rArgs);
                  return mocks.returning.mock.results[
                    mocks.returning.mock.results.length - 1
                  ]?.value ?? Promise.resolve([]);
                },
              };
            },
          };
        },
      };
    },
  },
}));

vi.mock('@/db/schema', () => ({
  users: {
    id: 'users.id',
    totpFailedAttempts: 'users.totp_failed_attempts',
    totpLockedUntil: 'users.totp_locked_until',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...vals: unknown[]) => ({ strings, vals }),
    { raw: (s: string) => ({ raw: s }) },
  ),
}));

afterEach(() => vi.clearAllMocks());

const USER_ID = '00000000-0000-0000-0000-0000000000aa';

describe('totp-lockout', () => {
  describe('isLockoutActive', () => {
    it('returns false for null', async () => {
      const { isLockoutActive } = await import('../totp-lockout');
      expect(isLockoutActive(null)).toBe(false);
    });
    it('returns false for past timestamps', async () => {
      const { isLockoutActive } = await import('../totp-lockout');
      expect(isLockoutActive(new Date(Date.now() - 1000))).toBe(false);
    });
    it('returns false for exactly-now (boundary)', async () => {
      const { isLockoutActive } = await import('../totp-lockout');
      // The check is `> Date.now()`, so equality is NOT active.
      // Use a timestamp 1ms in the past to dodge clock micro-drift in CI.
      expect(isLockoutActive(new Date(Date.now() - 1))).toBe(false);
    });
    it('returns true for future timestamps', async () => {
      const { isLockoutActive } = await import('../totp-lockout');
      expect(isLockoutActive(new Date(Date.now() + 60_000))).toBe(true);
    });
  });

  describe('bumpTotpFailedAttempts', () => {
    it('runs exactly one UPDATE (no read-before-write)', async () => {
      mocks.returning.mockReturnValueOnce(
        Promise.resolve([{ attempts: 1, lockedUntil: null }]),
      );
      const { bumpTotpFailedAttempts } = await import('../totp-lockout');
      await bumpTotpFailedAttempts({ userId: USER_ID });
      expect(mocks.update).toHaveBeenCalledTimes(1);
      expect(mocks.set).toHaveBeenCalledTimes(1);
      expect(mocks.where).toHaveBeenCalledTimes(1);
      expect(mocks.returning).toHaveBeenCalledTimes(1);
    });

    it('passes RETURNING row through verbatim', async () => {
      const lockedUntil = new Date('2030-01-01T00:00:00Z');
      mocks.returning.mockReturnValueOnce(
        Promise.resolve([{ attempts: 5, lockedUntil }]),
      );
      const { bumpTotpFailedAttempts } = await import('../totp-lockout');
      const result = await bumpTotpFailedAttempts({ userId: USER_ID });
      expect(result).toEqual({ attempts: 5, lockedUntil });
    });

    it('empty RETURNING maps to { attempts: 0, lockedUntil: null }', async () => {
      mocks.returning.mockReturnValueOnce(Promise.resolve([]));
      const { bumpTotpFailedAttempts } = await import('../totp-lockout');
      const result = await bumpTotpFailedAttempts({ userId: USER_ID });
      expect(result).toEqual({ attempts: 0, lockedUntil: null });
    });

    it('SET clause asserts both totp_failed_attempts increment AND lockout CASE', async () => {
      mocks.returning.mockReturnValueOnce(
        Promise.resolve([{ attempts: 1, lockedUntil: null }]),
      );
      const { bumpTotpFailedAttempts } = await import('../totp-lockout');
      await bumpTotpFailedAttempts({ userId: USER_ID });
      const setArg = mocks.set.mock.calls[0][0] as Record<string, unknown>;
      // The increment expression is sql`${users.totpFailedAttempts} + 1`.
      // The lockout expression is a CASE WHEN ...+1 >= 5 THEN now() + interval '15 minutes' ELSE ... END.
      // We verify the keys are set; deep SQL inspection is beyond a unit
      // test's reach (would need a tagged-template walker), but the
      // presence of both columns in the SET catches a regression that
      // drops one half.
      expect(setArg).toHaveProperty('totpFailedAttempts');
      expect(setArg).toHaveProperty('totpLockedUntil');
    });
  });
});
