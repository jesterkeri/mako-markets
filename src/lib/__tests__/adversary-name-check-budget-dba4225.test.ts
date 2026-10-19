// ----------------------------------------------------------------------------
// src/lib/__tests__/adversary-name-check-budget-dba4225.test.ts
//
// Adversary pass on dba4225 (per-account cap on GET /api/user/profile/name-available). Owner spec (Joshua 2026-10-17):
// the live check must not let anyone drive unbounded database load on a capped Neon free tier. name-check-budget.ts
// states it "Fails closed: no store, no check", and name-check-budget.test.ts pins "the store down or answering
// nonsense: 503, never an unlimited check".
//
// reserveNameCheck reads the script's reply with Number(...) and only rejects NaN/Infinity. Number() turns a null, an
// empty string, an empty array or false into 0, which is <= the cap, so every such reply is 'ok': the store answering
// anything but a count is an unlimited check, each one running the name queries. envio-budget.ts, which this module
// reuses, already demands a safe non-negative integer for the same kind of reply.
//
// Only upstashCommand (the transport), the session and the name query are stubbed; the route and reserveNameCheck are
// real.
// ----------------------------------------------------------------------------
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ session: vi.fn(), held: vi.fn(), upstash: vi.fn() }));
vi.mock('server-only', () => ({}));
// (Builder, Codex UNIQUE_NAMES R2: the cap is charged to the signed session cookie before any database query.)
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => ({ value: 'signed-sid' }) }) }));
vi.mock('@/lib/user-session', () => ({
  getUserSession: mocks.session,
  USER_SESSION_COOKIE: 'mako_user_session',
  verifySessionToken: (t: string) => (t ? { sid: t } : null),
}));
vi.mock('@/lib/display-name-holder', () => ({ nameHeldByOther: mocks.held }));
vi.mock('@/lib/envio-budget', () => ({ upstashCommand: mocks.upstash }));

import { NAME_CHECKS_PER_MINUTE } from '@/lib/name-check-budget';
import { GET } from '@/app/api/user/profile/name-available/route';

const ask = (name: string) => GET(new Request(`http://localhost/api/user/profile/name-available?name=${encodeURIComponent(name)}`));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ userId: 'u-1' });
  mocks.held.mockResolvedValue(false);
});

describe('name check cap, a reply that is not a count', () => {
  for (const [label, reply] of [
    ['null', null],
    ['empty string', ''],
    ['empty array', []],
    ['false', false],
  ] as const) {
    it(`a reply of ${label} is refused, not counted as zero checks`, async () => {
      mocks.upstash.mockResolvedValue(reply);
      const statuses: number[] = [];
      for (let i = 0; i < NAME_CHECKS_PER_MINUTE + 5; i++) statuses.push((await ask(`Probe${i}`)).status);
      expect(statuses.every((s) => s === 503)).toBe(true);
      expect(mocks.held).not.toHaveBeenCalled();
    });
  }
});
