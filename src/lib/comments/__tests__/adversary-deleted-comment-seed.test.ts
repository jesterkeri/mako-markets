// ----------------------------------------------------------------------------
// Adversary (public profile, 06166a8): a deleted comment must not say who wrote it.
//
// Contract: queries.ts toWire hides the author on a deleted row ("author identity is hidden there": no photo, no
// authorAddress, empty body) and PoolComments draws "a blank disc, no photo". Since 06166a8 avatarSeed is
// sha256(lowercase address) instead of sha256(user_id), and toWire still sends it on a deleted row. Every bettor's
// address is public (leaderboard, /u, comments), so hashing each candidate address and matching the seed names the
// author of the deleted comment, with no other comment of theirs on the page.
// ----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Address } from 'viem';

import { users } from '@/db/schema';
import { deriveSafeAddress } from '@/lib/safe';
import { createComment, softDeleteOwn } from '../mutations';
import { getCommentsPage, type CommentTarget } from '../queries';
import { createTestDb, type TestDb } from './test-db';

const MARKET: CommentTarget = {
  scope: 'main',
  chainId: 10143,
  contractAddress: '0xbc5a58487d7949da2b76ac84afc032fd0aa26195',
  marketId: '5',
};

let tdb: TestDb;
const db = () => tdb.db as never;
const eoa = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

beforeEach(async () => {
  tdb = await createTestDb();
});
afterEach(async () => {
  await tdb.close();
});

async function seedMagicUser(n: number, displayName: string) {
  const u = await tdb.db
    .insert(users)
    .values({ email: `${n}@x.co`, magicEoa: eoa(n), authType: 'magic', displayName })
    .returning({ id: users.id });
  return { userId: u[0].id, address: deriveSafeAddress(eoa(n) as Address).toLowerCase() };
}

describe('a deleted comment does not identify its author', () => {
  it('avatarSeed on a deleted row cannot be matched against public addresses', async () => {
    const author = await seedMagicUser(1, 'Whistleblower');
    const replier = await seedMagicUser(2, 'Bystander');
    // Addresses anyone can list from the public leaderboard.
    const publicAddresses = [author.address, replier.address, deriveSafeAddress(eoa(3) as Address).toLowerCase()];

    const top = await createComment(db(), { target: MARKET, userId: author.userId, parentId: null, body: 'regret this' });
    if (!top.ok) throw new Error('setup');
    await createComment(db(), { target: MARKET, userId: replier.userId, parentId: top.id, body: 'reply stays' });
    await softDeleteOwn(db(), top.id, author.userId);

    const page = await getCommentsPage(db(), MARKET, null, 30, null);
    const deleted = page.comments[0];
    expect(deleted.deleted).toBe(true);
    // The wire already hides the author's address and photo on this row...
    expect(deleted.authorAddress).toBeNull();
    expect(deleted.avatarUrl).toBeNull();
    // ...so the seed must not hand it back: nobody's public address may hash to it.
    const named = publicAddresses.filter((a) => sha(a) === deleted.avatarSeed);
    expect(named).toEqual([]);
  });
});
