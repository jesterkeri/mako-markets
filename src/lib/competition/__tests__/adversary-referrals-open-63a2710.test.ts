// Adversary pass on 63a2710 (referrals count from REFERRALS_OPEN and keep counting). Owner decision 4, 2026-10-24:
// "This competition's standings must not change after it ends: only referrals whose qualifying bet is before
// COMPETITION_END can enter someone into THIS competition." The standings filter only the friend's BET time, never
// when the friend became a referral (account creation or a code typed on Me), so a referral recorded after the end,
// with a bet from inside the window, enters its referrer into the finished competition.

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn }));
vi.mock('@/lib/aa-public-client', () => ({ getAaPublicClient: () => ({ multicall: async () => [] }) }));

import { COMPETITION_END } from '@/lib/competition/config';
import { referralCounts, setReferrer } from '@/lib/competition/referrals';
import { readPositions } from '@/lib/competition/standings';
import type { TestDb } from '@/lib/leaderboard/__tests__/test-db';

import { account, addr, at, codeOf, competitionDb, event } from './db';

let t: TestDb | null = null;
afterEach(async () => {
  vi.useRealTimers();
  await t?.close();
  t = null;
});

const U = 1_000_000n;
const REF = addr('a1');
const AFTER_END = new Date(COMPETITION_END.getTime() + 2 * 60 * 60 * 1000);
const actors = async (db: TestDb) => [...new Set((await readPositions(db.db as never)).map((r) => r.actor))];

/// The referrer with one qualifying friend (link sign-up and bet inside the window): not entered.
async function oneFriend(db: TestDb) {
  await account(db, { wallet: REF });
  await account(db, { wallet: addr('f1'), ref: codeOf(REF) });
  await event(db, { actor: addr('f1'), market: 900, kind: 'bet', amount: U / 10n, when: at(2) });
}

describe('standings after the end (owner decision 4, 2026-10-24)', () => {
  it('a wallet that bet during the competition and signs up through the link after the end enters no one', async () => {
    t = await competitionDb();
    await oneFriend(t);
    // A wallet bets on the live contract during the competition, with no Mako Market account yet.
    await event(t, { actor: addr('b9'), market: 901, kind: 'bet', amount: U / 10n, when: at(5) });
    const atEnd = await actors(t);
    expect(atEnd).toEqual([]);

    // Two hours after the end it signs up through REF's link.
    await account(t, { wallet: addr('b9'), ref: codeOf(REF), createdAt: AFTER_END });
    expect(await actors(t)).toEqual(atEnd);
  });

  it('a friend who bet during the competition and types the code on Me after the end enters no one', async () => {
    t = await competitionDb();
    await oneFriend(t);
    const friend = await account(t, { wallet: addr('b8'), createdAt: at(1) });
    await event(t, { actor: addr('b8'), market: 902, kind: 'bet', amount: U / 10n, when: at(3) });
    const atEnd = await actors(t);
    expect(atEnd).toEqual([]);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(AFTER_END);
    // Fix (Claude): an account created during the competition may no longer add an inviter once it has ended, so the
    // code cannot reach THIS competition; the Me card stops offering the field too.
    expect(await setReferrer(t.db as never, friend, codeOf(REF))).toEqual({ ok: false, error: 'too_old' });
    expect((await referralCounts(t.db as never, friend, codeOf(addr('b8')))).canAddInviter).toBe(false);
    expect(await actors(t)).toEqual(atEnd);
    // An account created after the end may still add one: referrals keep counting for later competitions.
    const later = await account(t, { wallet: addr('b7'), createdAt: AFTER_END });
    expect((await referralCounts(t.db as never, later, codeOf(addr('b7')))).canAddInviter).toBe(true);
    expect(await setReferrer(t.db as never, later, codeOf(REF))).toEqual({ ok: true });
  });
});
