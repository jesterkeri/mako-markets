// ----------------------------------------------------------------------------
// src/lib/comments/__tests__/queries.test.ts
//
// Integration tests for the comments read + write layer against real Postgres
// (pglite). Covers the security-load-bearing behavior: badge casing
// (checksummed safe vs lowercase actor — the #186 trap), wire-shape privacy,
// soft-delete display rules, depth-1 / parent-mismatch / parent-deleted,
// BOLA delete, keyset + reply-window pagination, and parentBelongsToTarget.
// ----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Address } from 'viem';

import { makoMarketEvents, users } from '@/db/schema';
import { deriveSafeAddress } from '@/lib/safe';
import { decodeCursor } from '../cursor';
import {
  createComment,
  softDeleteAsAdmin,
  softDeleteOwn,
} from '../mutations';
import {
  getCommentsPage,
  getRepliesPage,
  parentBelongsToTarget,
  type CommentTarget,
} from '../queries';
import { createTestDb, type TestDb } from './test-db';

const CHAIN_ID = 10143;
const CONTRACT = '0xbc5a58487d7949da2b76ac84afc032fd0aa26195';
const MARKET_5: CommentTarget = {
  scope: 'main',
  chainId: CHAIN_ID,
  contractAddress: CONTRACT,
  marketId: '5',
};
const MARKET_6: CommentTarget = { ...MARKET_5, marketId: '6' };

let tdb: TestDb;
let txSeq = 0;

const db = () => tdb.db as never; // pglite db → DbOrTx (leaderboard convention)

beforeEach(async () => {
  tdb = await createTestDb();
  txSeq = 0;
});
afterEach(async () => {
  await tdb.close();
});

async function seedMagicUser(
  eoa: string,
  displayName?: string,
): Promise<{ userId: string; safeLower: string }> {
  const u = await tdb.db
    .insert(users)
    .values({ email: `${eoa}@x.co`, magicEoa: eoa, authType: 'magic', displayName })
    .returning({ id: users.id });
  const safeLower = deriveSafeAddress(eoa as Address).toLowerCase();
  return { userId: u[0].id, safeLower };
}

async function seedBet(actorLower: string, marketId: string, isYes: boolean): Promise<void> {
  txSeq += 1;
  await tdb.db.insert(makoMarketEvents).values({
    chainId: CHAIN_ID,
    contractAddress: CONTRACT,
    version: 'v4',
    marketId,
    kind: 'bet',
    actor: actorLower,
    isYes,
    amount: '1000000',
    blockNumber: 100 + txSeq,
    blockTimestamp: new Date('2026-07-01T00:00:00Z'),
    txHash: `0x${txSeq.toString(16).padStart(64, '0')}`,
    logIndex: 0,
  });
}

// A distinct EOA per index (valid lowercase 40-hex).
const eoa = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;

describe('createComment + getCommentsPage — happy path', () => {
  it('returns a top-level comment with the expected wire shape', async () => {
    const { userId } = await seedMagicUser(eoa(1), 'Ann');
    const created = await createComment(db(), {
      target: MARKET_5,
      userId,
      parentId: null,
      body: 'first!',
    });
    expect(created.ok).toBe(true);

    const page = await getCommentsPage(db(), MARKET_5, null, 30, userId);
    expect(page.comments).toHaveLength(1);
    const c = page.comments[0];
    expect(c.body).toBe('first!');
    expect(c.authorLabel).toBe('Ann');
    expect(c.avatarSeed).toBe(createHash('sha256').update(userId).digest('hex'));
    expect(c.avatarUrl).toBeNull(); // this seeded user uploaded no photo
    expect(c.isOwn).toBe(true);
    expect(c.deleted).toBe(false);
    expect(c.position).toBeNull(); // no bet yet
    expect(c.replies).toEqual([]);
    expect(c.repliesNextCursor).toBeNull();
  });

  it('isOwn is false for a different viewer and when signed out', async () => {
    const { userId } = await seedMagicUser(eoa(1));
    await createComment(db(), { target: MARKET_5, userId, parentId: null, body: 'x' });
    const asOther = await getCommentsPage(db(), MARKET_5, null, 30, 'someone-else');
    expect(asOther.comments[0].isOwn).toBe(false);
    const signedOut = await getCommentsPage(db(), MARKET_5, null, 30, null);
    expect(signedOut.comments[0].isOwn).toBe(false);
  });
});

describe('position badges (checksummed safe vs lowercase actor — #186 trap)', () => {
  it('yes / no / both / null resolve correctly', async () => {
    const yesUser = await seedMagicUser(eoa(1), 'Yes');
    const bothUser = await seedMagicUser(eoa(2), 'Both');
    const noneUser = await seedMagicUser(eoa(3), 'None');
    // ledger actors are LOWERCASE; safe addresses are checksummed — the join
    // must lower() both sides (identity.ts already lowercases).
    await seedBet(yesUser.safeLower, '5', true);
    await seedBet(bothUser.safeLower, '5', true);
    await seedBet(bothUser.safeLower, '5', false);

    for (const u of [yesUser, bothUser, noneUser]) {
      await createComment(db(), { target: MARKET_5, userId: u.userId, parentId: null, body: 'hi' });
    }
    const page = await getCommentsPage(db(), MARKET_5, null, 30, null);
    const byLabel = new Map(page.comments.map((c) => [c.authorLabel, c.position]));
    expect(byLabel.get('Yes')).toBe('yes');
    expect(byLabel.get('Both')).toBe('both');
    expect(byLabel.get('None')).toBeNull();
  });

  it('a bet on a DIFFERENT market does not badge this market', async () => {
    const u = await seedMagicUser(eoa(1), 'Ann');
    await seedBet(u.safeLower, '6', true); // bet on market 6, comment on 5
    await createComment(db(), { target: MARKET_5, userId: u.userId, parentId: null, body: 'hi' });
    const page = await getCommentsPage(db(), MARKET_5, null, 30, null);
    expect(page.comments[0].position).toBeNull();
  });
});

describe('wire-shape privacy + avatarSeed non-reversibility', () => {
  it('never serializes email / magic_eoa / user_id / raw address for a named user', async () => {
    const { userId, safeLower } = await seedMagicUser(eoa(0xabc), 'Named');
    await createComment(db(), { target: MARKET_5, userId, parentId: null, body: 'hi' });
    const page = await getCommentsPage(db(), MARKET_5, null, 30, userId);
    const json = JSON.stringify(page);
    expect(json).not.toContain('@x.co'); // email
    expect(json).not.toContain(eoa(0xabc)); // magic_eoa
    expect(json).not.toContain(userId); // internal id
    expect(json).not.toContain(safeLower); // raw address hidden behind the name
    expect(page.comments[0].avatarSeed).toBe(
      createHash('sha256').update(userId).digest('hex'),
    );
    // No photo uploaded → avatarUrl is null → the internal user_id assertion
    // above stays true. The user_id only rides along inside avatarUrl for
    // users who HAVE a photo (accepted 2026-07-07), covered by the next test.
    expect(page.comments[0].avatarUrl).toBeNull();
  });

  it('serializes the photo URL when it is an OWNED Vercel Blob URL', async () => {
    const u = await tdb.db
      .insert(users)
      .values({ email: 'pho@x.co', magicEoa: eoa(0x7ac), authType: 'magic', displayName: 'Pho' })
      .returning({ id: users.id });
    const userId = u[0].id;
    // Owned = Vercel Blob host + this user's own /avatars/<id>/ prefix.
    const PHOTO = `https://x.public.blob.vercel-storage.com/avatars/${userId}/a.webp`;
    await tdb.db.update(users).set({ avatarUrl: PHOTO }).where(eq(users.id, userId));

    await createComment(db(), { target: MARKET_5, userId, parentId: null, body: 'hi' });
    const page = await getCommentsPage(db(), MARKET_5, null, 30, null);
    expect(page.comments[0].avatarUrl).toBe(PHOTO);
  });

  it('FILTERS a legacy non-owned avatar_url (arbitrary host) to null (Codex MAJOR)', async () => {
    // migration 0004 allowed "https-only paste" before the upload infra, so a
    // legacy row can hold an attacker host. It must NOT reach the public wire.
    const u = await tdb.db
      .insert(users)
      .values({
        email: 'evil@x.co',
        magicEoa: eoa(0x7ad),
        authType: 'magic',
        displayName: 'Evil',
        avatarUrl: 'https://attacker.example/track.webp',
      })
      .returning({ id: users.id });
    await createComment(db(), { target: MARKET_5, userId: u[0].id, parentId: null, body: 'hi' });
    const page = await getCommentsPage(db(), MARKET_5, null, 30, null);
    expect(page.comments[0].avatarUrl).toBeNull(); // filtered → glyph fallback
  });

  it("FILTERS a Vercel Blob URL under ANOTHER user's /avatars/ prefix", async () => {
    const u = await tdb.db
      .insert(users)
      .values({ email: 'imp@x.co', magicEoa: eoa(0x7ae), authType: 'magic', displayName: 'Imp' })
      .returning({ id: users.id });
    // Right host, WRONG owner path → still filtered (no impersonation).
    const FOREIGN = 'https://x.public.blob.vercel-storage.com/avatars/someone-else/a.webp';
    await tdb.db.update(users).set({ avatarUrl: FOREIGN }).where(eq(users.id, u[0].id));

    await createComment(db(), { target: MARKET_5, userId: u[0].id, parentId: null, body: 'hi' });
    const page = await getCommentsPage(db(), MARKET_5, null, 30, null);
    expect(page.comments[0].avatarUrl).toBeNull();
  });

  it('shows the truncated address as the label when there is no display name', async () => {
    const { userId, safeLower } = await seedMagicUser(eoa(0xdef)); // no name
    await createComment(db(), { target: MARKET_5, userId, parentId: null, body: 'hi' });
    const page = await getCommentsPage(db(), MARKET_5, null, 30, null);
    // fallback label = formatAddress(lowercased safe) — intended exposure
    expect(page.comments[0].authorLabel).toContain(safeLower.slice(0, 6));
  });
});

describe('replies + depth-1 + parent validation', () => {
  it('inlines replies under their top-level parent', async () => {
    const { userId } = await seedMagicUser(eoa(1), 'Ann');
    const top = await createComment(db(), { target: MARKET_5, userId, parentId: null, body: 'top' });
    if (!top.ok) throw new Error('setup');
    await createComment(db(), { target: MARKET_5, userId, parentId: top.id, body: 'reply' });

    const page = await getCommentsPage(db(), MARKET_5, null, 30, null);
    expect(page.comments).toHaveLength(1);
    expect(page.comments[0].replies).toHaveLength(1);
    expect(page.comments[0].replies[0].body).toBe('reply');
    expect(page.comments[0].replies[0].parentId).toBe(top.id);
  });

  it('rejects a reply to a reply (depth-1)', async () => {
    const { userId } = await seedMagicUser(eoa(1));
    const top = await createComment(db(), { target: MARKET_5, userId, parentId: null, body: 't' });
    if (!top.ok) throw new Error('setup');
    const reply = await createComment(db(), { target: MARKET_5, userId, parentId: top.id, body: 'r' });
    if (!reply.ok) throw new Error('setup');
    const deep = await createComment(db(), { target: MARKET_5, userId, parentId: reply.id, body: 'd' });
    expect(deep).toEqual({ ok: false, error: 'parent_not_top_level' });
  });

  it('rejects a reply whose parent is on a different market', async () => {
    const { userId } = await seedMagicUser(eoa(1));
    const top = await createComment(db(), { target: MARKET_5, userId, parentId: null, body: 't' });
    if (!top.ok) throw new Error('setup');
    const cross = await createComment(db(), { target: MARKET_6, userId, parentId: top.id, body: 'x' });
    expect(cross).toEqual({ ok: false, error: 'parent_mismatch' });
  });

  it('rejects a reply to a deleted parent', async () => {
    const { userId } = await seedMagicUser(eoa(1));
    const top = await createComment(db(), { target: MARKET_5, userId, parentId: null, body: 't' });
    if (!top.ok) throw new Error('setup');
    await softDeleteOwn(db(), top.id, userId);
    const late = await createComment(db(), { target: MARKET_5, userId, parentId: top.id, body: 'r' });
    expect(late).toEqual({ ok: false, error: 'parent_deleted' });
  });

  it('rejects a nonexistent parent', async () => {
    const { userId } = await seedMagicUser(eoa(1));
    const res = await createComment(db(), {
      target: MARKET_5,
      userId,
      parentId: '99999999-9999-4999-8999-999999999999',
      body: 'r',
    });
    expect(res).toEqual({ ok: false, error: 'parent_not_found' });
  });
});

describe('soft-delete display rules', () => {
  it('a deleted top-level WITH a live reply is shown as deleted with empty body', async () => {
    const { userId } = await seedMagicUser(eoa(1));
    const top = await createComment(db(), { target: MARKET_5, userId, parentId: null, body: 'secret' });
    if (!top.ok) throw new Error('setup');
    await createComment(db(), { target: MARKET_5, userId, parentId: top.id, body: 'reply lives' });
    await softDeleteOwn(db(), top.id, userId);

    const page = await getCommentsPage(db(), MARKET_5, null, 30, null);
    expect(page.comments).toHaveLength(1);
    expect(page.comments[0].deleted).toBe(true);
    expect(page.comments[0].body).toBe('');
    expect(JSON.stringify(page)).not.toContain('secret');
    expect(page.comments[0].replies[0].body).toBe('reply lives');
  });

  it('a deleted top-level WITHOUT replies is absent', async () => {
    const { userId } = await seedMagicUser(eoa(1));
    const top = await createComment(db(), { target: MARKET_5, userId, parentId: null, body: 'gone' });
    if (!top.ok) throw new Error('setup');
    await softDeleteOwn(db(), top.id, userId);
    const page = await getCommentsPage(db(), MARKET_5, null, 30, null);
    expect(page.comments).toHaveLength(0);
  });

  it('a deleted reply is never shown', async () => {
    const { userId } = await seedMagicUser(eoa(1));
    const top = await createComment(db(), { target: MARKET_5, userId, parentId: null, body: 't' });
    if (!top.ok) throw new Error('setup');
    const r1 = await createComment(db(), { target: MARKET_5, userId, parentId: top.id, body: 'r1' });
    if (!r1.ok) throw new Error('setup');
    await createComment(db(), { target: MARKET_5, userId, parentId: top.id, body: 'r2' });
    await softDeleteOwn(db(), r1.id, userId);
    const page = await getCommentsPage(db(), MARKET_5, null, 30, null);
    expect(page.comments[0].replies.map((r) => r.body)).toEqual(['r2']);
  });
});

describe('BOLA delete', () => {
  it('a non-owner cannot delete another user comment; the owner and an admin can', async () => {
    const owner = await seedMagicUser(eoa(1));
    const other = await seedMagicUser(eoa(2));
    const top = await createComment(db(), {
      target: MARKET_5,
      userId: owner.userId,
      parentId: null,
      body: 't',
    });
    if (!top.ok) throw new Error('setup');

    expect(await softDeleteOwn(db(), top.id, other.userId)).toBe(false);
    // still visible / not deleted
    let page = await getCommentsPage(db(), MARKET_5, null, 30, null);
    expect(page.comments[0].deleted).toBe(false);

    expect(await softDeleteOwn(db(), top.id, owner.userId)).toBe(true);
    // second delete is a no-op (already deleted)
    expect(await softDeleteAsAdmin(db(), top.id)).toBe(false);
    page = await getCommentsPage(db(), MARKET_5, null, 30, null);
    expect(page.comments).toHaveLength(0); // deleted, no replies → hidden
  });

  it('admin can delete any comment', async () => {
    const owner = await seedMagicUser(eoa(1));
    const top = await createComment(db(), {
      target: MARKET_5,
      userId: owner.userId,
      parentId: null,
      body: 't',
    });
    if (!top.ok) throw new Error('setup');
    expect(await softDeleteAsAdmin(db(), top.id)).toBe(true);
  });
});

describe('keyset pagination + reply window', () => {
  it('pages top-level comments with no dup/skip', async () => {
    const { userId } = await seedMagicUser(eoa(1));
    for (let i = 0; i < 5; i++) {
      await createComment(db(), { target: MARKET_5, userId, parentId: null, body: `c${i}` });
    }
    const p1 = await getCommentsPage(db(), MARKET_5, null, 2, null);
    expect(p1.comments).toHaveLength(2);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await getCommentsPage(db(), MARKET_5, decodeCursor(p1.nextCursor!), 2, null);
    const p3 = await getCommentsPage(db(), MARKET_5, decodeCursor(p2.nextCursor!), 2, null);
    const bodies = [...p1.comments, ...p2.comments, ...p3.comments].map((c) => c.body);
    expect(new Set(bodies).size).toBe(5); // no dups
    expect(bodies).toHaveLength(5); // no skips
  });

  it('caps inline replies at REPLY_PAGE and paginates the rest', async () => {
    const { userId } = await seedMagicUser(eoa(1));
    const top = await createComment(db(), { target: MARKET_5, userId, parentId: null, body: 't' });
    if (!top.ok) throw new Error('setup');
    for (let i = 0; i < 5; i++) {
      await createComment(db(), { target: MARKET_5, userId, parentId: top.id, body: `r${i}` });
    }
    const page = await getCommentsPage(db(), MARKET_5, null, 30, null);
    expect(page.comments[0].replies).toHaveLength(3);
    expect(page.comments[0].repliesNextCursor).not.toBeNull();

    const more = await getRepliesPage(
      db(),
      MARKET_5,
      top.id,
      decodeCursor(page.comments[0].repliesNextCursor!),
      30,
      null,
    );
    const all = [...page.comments[0].replies, ...more.comments].map((r) => r.body);
    expect(all).toEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
  });
});

describe('parentBelongsToTarget (reply-page leak guard)', () => {
  it('true for a top-level under the target; false for wrong target / a reply id / nonexistent', async () => {
    const { userId } = await seedMagicUser(eoa(1));
    const top = await createComment(db(), { target: MARKET_5, userId, parentId: null, body: 't' });
    if (!top.ok) throw new Error('setup');
    const reply = await createComment(db(), { target: MARKET_5, userId, parentId: top.id, body: 'r' });
    if (!reply.ok) throw new Error('setup');

    expect(await parentBelongsToTarget(db(), top.id, MARKET_5)).toBe(true);
    expect(await parentBelongsToTarget(db(), top.id, MARKET_6)).toBe(false); // wrong market
    expect(await parentBelongsToTarget(db(), reply.id, MARKET_5)).toBe(false); // not top-level
    expect(
      await parentBelongsToTarget(db(), '99999999-9999-4999-8999-999999999999', MARKET_5),
    ).toBe(false);
  });
});
