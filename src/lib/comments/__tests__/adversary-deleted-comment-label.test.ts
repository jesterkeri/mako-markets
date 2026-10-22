// ----------------------------------------------------------------------------
// Adversary (public profile, 77028ce): the comments API still names the author of a deleted comment.
//
// Contract (Joshua 2026-10-17): "A deleted comment hides its author entirely." 77028ce blanks the seed, photo and
// authorAddress on a deleted row, and PoolComments hides the name and badge there, but GET /api/comments returns
// getCommentsPage as JSON verbatim (src/app/api/comments/route.ts), so whatever toWire puts on the row is public.
// toWire still sends authorLabel (display name, or the truncated address) and the position badge on a deleted row.
// ----------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Address } from 'viem';

import { makoMarketEvents, users } from '@/db/schema';
import { deriveSafeAddress } from '@/lib/safe';
import { createComment, softDeleteOwn } from '../mutations';
import { getCommentsPage, type CommentTarget } from '../queries';
import { createTestDb, type TestDb } from './test-db';

const CHAIN_ID = 10143;
const CONTRACT = '0xbc5a58487d7949da2b76ac84afc032fd0aa26195';
const MARKET: CommentTarget = { scope: 'main', chainId: CHAIN_ID, contractAddress: CONTRACT, marketId: '5' };

let tdb: TestDb;
const db = () => tdb.db as never;
const eoa = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;

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

describe('a deleted comment does not identify its author on the wire', () => {
  it('sends neither the display name nor the betting side of a deleted comment', async () => {
    const author = await seedMagicUser(1, 'Whistleblower');
    const replier = await seedMagicUser(2, 'Bystander');
    // The author holds YES on this market (a public on-chain bet).
    await tdb.db.insert(makoMarketEvents).values({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      version: 'v4',
      marketId: '5',
      kind: 'bet',
      actor: author.address,
      isYes: true,
      amount: '1000000',
      blockNumber: 101,
      blockTimestamp: new Date('2026-07-01T00:00:00Z'),
      txHash: `0x${'1'.padStart(64, '0')}`,
      logIndex: 0,
    });

    const top = await createComment(db(), { target: MARKET, userId: author.userId, parentId: null, body: 'regret this' });
    if (!top.ok) throw new Error('setup');
    await createComment(db(), { target: MARKET, userId: replier.userId, parentId: top.id, body: 'reply stays' });
    await softDeleteOwn(db(), top.id, author.userId);

    // Anonymous viewer, exactly what GET /api/comments serialises.
    const page = await getCommentsPage(db(), MARKET, null, 30, null);
    const deleted = page.comments[0];
    expect(deleted.deleted).toBe(true);
    expect(deleted.authorAddress).toBeNull();
    // The author's chosen name must not ride on the deleted row.
    expect(JSON.stringify(deleted)).not.toContain('Whistleblower');
    expect(deleted.authorLabel).not.toBe('Whistleblower');
    // Nor their position badge, which narrows the author to the bettors on one side.
    expect(deleted.position).toBeNull();
  });
});
