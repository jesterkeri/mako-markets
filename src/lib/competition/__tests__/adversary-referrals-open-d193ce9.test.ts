// Adversary pass on d193ce9 (a referral recorded after the end cannot enter anyone into that competition). Owner
// decision 4, 2026-10-24: "This competition's standings must not change after it ends." d193ce9 bounds the FRIEND's
// account and bet by COMPETITION_END, but never the REFERRER's account. The link path (src/lib/user-upsert.ts) stores
// any well-formed `r-` tag at sign-up without checking the code belongs to an account, and a code is computable from
// any public address, so friends can join through the link of a wallet that has no Mako Market account yet. That
// wallet bets during the competition, signs up after the end, and is then listed in the finished competition.

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn }));
vi.mock('@/lib/aa-public-client', () => ({ getAaPublicClient: () => ({ multicall: async () => [] }) }));

import { COMPETITION_END } from '@/lib/competition/config';
import { readPositions } from '@/lib/competition/standings';
import type { TestDb } from '@/lib/leaderboard/__tests__/test-db';

import { account, addr, at, codeOf, competitionDb, event } from './db';

let t: TestDb | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

const U = 1_000_000n;
const AFTER_END = new Date(COMPETITION_END.getTime() + 2 * 60 * 60 * 1000);
const actors = async (db: TestDb) => [...new Set((await readPositions(db.db as never)).map((r) => r.actor))];

describe('standings after the end: the referrer side (owner decision 4, 2026-10-24)', () => {
  it('a wallet whose two friends qualified during the competition, but which signs up only after the end, enters no one', async () => {
    t = await competitionDb();
    const X = addr('c3');
    // X bets on the live contract during the competition with no Mako Market account.
    await event(t, { actor: X, market: 910, kind: 'bet', amount: U, when: at(4) });
    // Two friends sign up through X's link during the competition (the link path stores the tag unchecked) and bet.
    for (const f of ['d1', 'd2']) {
      await account(t, { wallet: addr(f), ref: codeOf(X), createdAt: at(2) });
      await event(t, { actor: addr(f), market: 911, kind: 'bet', amount: U / 10n, when: at(3) });
    }
    const atEnd = await actors(t);
    expect(atEnd).toEqual([]);

    // Two hours after the end, X creates its account.
    await account(t, { wallet: X, createdAt: AFTER_END });
    expect(await actors(t)).toEqual(atEnd);
  });
});
