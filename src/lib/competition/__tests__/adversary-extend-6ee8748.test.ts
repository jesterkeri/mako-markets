// Adversary pass on 6ee8748 (competition extended 7 days, owner decision 2026-11-03): ends 2026-11-14 12:00 UTC, was
// 2026-11-07 12:00 UTC. Everything keyed on the end follows it with the same boundary semantics; the week between the
// old and the new end is inside the competition.

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn }));
vi.mock('@/lib/aa-public-client', () => ({ getAaPublicClient: () => ({ multicall: async () => [] }) }));

import { COMPETITION_COPY, COMPETITION_END, competitionStatus } from '@/lib/competition/config';
import { referralCounts, setReferrer } from '@/lib/competition/referrals';
import { readPositions } from '@/lib/competition/standings';
import type { TestDb } from '@/lib/leaderboard/__tests__/test-db';

import { account, addr, codeOf, competitionDb, event } from './db';

const U = 1_000_000n;
const OLD_END = new Date('2026-11-07T12:00:00Z');
const NEW_END = new Date('2026-11-14T12:00:00Z');
const ms = (d: Date, delta: number) => new Date(d.getTime() + delta);

let t: TestDb | null = null;
afterEach(async () => {
  vi.useRealTimers();
  await t?.close();
  t = null;
});

describe('the extended end (owner 2026-11-03)', () => {
  it('END is the new instant', () => {
    expect(COMPETITION_END.getTime()).toBe(NEW_END.getTime());
  });

  it('status: live from the old end until 1 ms before the new end, final at the new end', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(OLD_END);
    expect(competitionStatus()).toBe('Live until 2026-11-14 12:00 UTC.');
    vi.setSystemTime(ms(NEW_END, -1));
    expect(competitionStatus()).toBe(COMPETITION_COPY.live);
    vi.setSystemTime(NEW_END);
    expect(competitionStatus()).toBe('Final standings, under review.');
  });

  it('no copy string still names Nov 7', () => {
    expect(JSON.stringify(COMPETITION_COPY)).not.toMatch(/11-07|Nov(ember)? 7/);
  });

  it('a friend who signs up and bets in the extra week enters the referrer; bets and claims in it count; END itself is out', async () => {
    t = await competitionDb();
    const REF = addr('a1');
    await account(t, { wallet: REF });
    await account(t, { wallet: addr('f1'), ref: codeOf(REF), createdAt: ms(OLD_END, 1) });
    await event(t, { actor: addr('f1'), market: 1, kind: 'bet', amount: U, when: ms(OLD_END, 1) });
    await account(t, { wallet: addr('f2'), ref: codeOf(REF), createdAt: ms(NEW_END, -2) });
    await event(t, { actor: addr('f2'), market: 1, kind: 'bet', amount: U, when: ms(NEW_END, -1) });
    await event(t, { actor: REF, market: 7, kind: 'bet', amount: 2n * U, when: OLD_END });
    await event(t, { actor: REF, market: 7, kind: 'claim', amount: 3n * U, when: ms(NEW_END, -1) });
    await event(t, { actor: REF, market: 8, kind: 'bet', amount: U, when: NEW_END });
    await event(t, { actor: REF, market: 7, kind: 'claim', amount: 5n * U, when: NEW_END });
    expect(await readPositions(t.db as never)).toEqual([{ actor: REF, market: '7', yes: 2n * U, no: 0n, claimed: 3n * U }]);
  });

  it('a friend whose bet is exactly at the new END does not qualify', async () => {
    t = await competitionDb();
    const REF = addr('a1');
    await account(t, { wallet: REF });
    await account(t, { wallet: addr('f1'), ref: codeOf(REF), createdAt: ms(OLD_END, 1) });
    await event(t, { actor: addr('f1'), market: 1, kind: 'bet', amount: U, when: ms(OLD_END, 1) });
    await account(t, { wallet: addr('f2'), ref: codeOf(REF), createdAt: ms(NEW_END, -2) });
    await event(t, { actor: addr('f2'), market: 1, kind: 'bet', amount: U, when: NEW_END });
    expect(await readPositions(t.db as never)).toEqual([]);
  });

  it('a code typed in the extra week is accepted; at the new END it is refused for an account created during the competition', async () => {
    t = await competitionDb();
    const REF = addr('a1');
    await account(t, { wallet: REF });
    const friend = await account(t, { wallet: addr('f3'), createdAt: ms(OLD_END, -5) });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(ms(OLD_END, 60 * 60 * 1000));
    expect((await referralCounts(t.db as never, friend, codeOf(addr('f3')))).canAddInviter).toBe(true);
    expect(await setReferrer(t.db as never, friend, codeOf(REF))).toEqual({ ok: true });

    const late = await account(t, { wallet: addr('f4'), createdAt: ms(NEW_END, -5) });
    vi.setSystemTime(NEW_END);
    expect(await setReferrer(t.db as never, late, codeOf(REF))).toEqual({ ok: false, error: 'too_old' });
  });
});
