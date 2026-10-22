// #214 S1: reply notifications, written in createComment's transaction (NOTIFICATIONS_PLAN r8 §3.2(3); §8 S1
// "Replies" and the (F1)/(prefs) adversary cases). Real migrations 0000..0020.
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { pmMarkets } from '@/db/schema';
import { createComment } from '@/lib/comments/mutations';

import { CHAIN, createNotifyDb, notificationsOf, walletAccount, type NotifyDb } from './harness';

const CONTRACT = '0xbc5a58487d7949da2b76ac84afc032fd0aa26195';
const MAIN = { scope: 'main' as const, chainId: CHAIN, contractAddress: CONTRACT, marketId: '123' };

let t: NotifyDb | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

async function setup() {
  t = await createNotifyDb();
  const author = await walletAccount(t, '0x00000000000000000000000000000000000a0001');
  const replier = await walletAccount(t, '0x00000000000000000000000000000000000a0002');
  const parent = await createComment(t.db as never, { target: MAIN, userId: author, parentId: null, body: 'top' });
  if (!parent.ok) throw new Error('parent insert failed');
  return { db: t, author, replier, parentId: parent.id };
}

const reply = (db: NotifyDb, userId: string, parentId: string, target: Parameters<typeof createComment>[1]['target'] = MAIN) =>
  createComment(db.db as never, { target, userId, parentId, body: 'a reply' });

describe('reply notifications', () => {
  it('a reply gives the parent author one row, with the pool id and no text, name or address', async () => {
    const { db, author, replier, parentId } = await setup();
    expect((await reply(db, replier, parentId)).ok).toBe(true);
    const rows = await notificationsOf(db, author);
    expect(rows).toEqual([expect.objectContaining({ kind: 'reply', dedupe_key: `reply:${parentId}`, data: { poolId: '123', count: 1 }, read_at: null })]);
    expect(await notificationsOf(db, replier)).toHaveLength(0);
  });

  it('a self-reply gives none', async () => {
    const { db, author, parentId } = await setup();
    await reply(db, author, parentId);
    expect(await notificationsOf(db)).toHaveLength(0);
  });

  it('replies group into one row with a count; a read row re-opens as a new item with count 1', async () => {
    const { db, author, replier, parentId } = await setup();
    await reply(db, replier, parentId);
    await reply(db, replier, parentId);
    await reply(db, replier, parentId);
    expect((await notificationsOf(db, author)).map((r) => r.data)).toEqual([{ poolId: '123', count: 3 }]);
    await db.client.query(`UPDATE notifications SET read_at = now(), email_id = gen_random_uuid() WHERE user_id = $1`, [author]);
    await reply(db, replier, parentId);
    const [row] = await db.client.query<{ data: unknown; read_at: string | null; email_id: string | null }>(
      `SELECT data, read_at, email_id FROM notifications WHERE user_id = $1`,
      [author],
    ).then((r) => r.rows);
    expect(row).toEqual({ data: { poolId: '123', count: 1 }, read_at: null, email_id: null });
  });

  it('an unread row keeps its email id when a new reply arrives', async () => {
    const { db, author, replier, parentId } = await setup();
    await reply(db, replier, parentId);
    const email = (await db.client.query<{ id: string }>(`SELECT gen_random_uuid()::text AS id`)).rows[0].id;
    await db.client.query(`UPDATE notifications SET email_id = $2 WHERE user_id = $1`, [author, email]);
    await reply(db, replier, parentId);
    const r = await db.client.query<{ email_id: string; data: { count: number } }>(`SELECT email_id::text, data FROM notifications WHERE user_id = $1`, [author]);
    expect(r.rows[0]).toEqual({ email_id: email, data: { poolId: '123', count: 2 } });
  });

  it('the reply switch off gives none; a malformed stored value commits both the comment and the notification', async () => {
    const { db, author, replier, parentId } = await setup();
    await db.client.query(`UPDATE users SET notification_prefs = '{"kinds":{"reply":false}}' WHERE id = $1`, [author]);
    expect((await reply(db, replier, parentId)).ok).toBe(true);
    expect(await notificationsOf(db)).toHaveLength(0);
    for (const bad of ['{"kinds":{"reply":"yes"}}', '{"kinds":{"reply":1}}', '{"kinds":{"reply":null}}', '{"kinds":[]}', '[]', '"x"', '{"email":"no"}']) {
      await db.client.query(`UPDATE users SET notification_prefs = $2::jsonb WHERE id = $1`, [author, bad]);
      expect((await reply(db, replier, parentId)).ok).toBe(true);
    }
    expect((await notificationsOf(db, author)).map((r) => r.data)).toEqual([{ poolId: '123', count: 7 }]);
  });

  it('a private-market reply gives none', async () => {
    const { db, replier, author } = await setup();
    const [pm] = await db.db
      .insert(pmMarkets)
      .values({
        chainId: CHAIN,
        contractAddress: CONTRACT,
        slug: 'pm-1',
        clientNonce: '0x0000000000000000000000000000000000000000000000000000000000000001',
        creator: '0x1111111111111111111111111111111111111111',
        marketId: 1,
        shape: 'friendly',
        createStatus: 'confirmed',
        title: 'PM One',
        visibilityView: 0,
        visibilityParticipation: 0,
        stakingOpensAt: new Date('2026-05-12T00:01:00Z'),
        closeAt: new Date('2026-05-12T00:10:00Z'),
      })
      .returning({ id: pmMarkets.id });
    const target = { scope: 'pm' as const, pmMarketDbId: pm.id };
    const parent = await createComment(db.db as never, { target, userId: author, parentId: null, body: 'pm top' });
    if (!parent.ok) throw new Error('pm parent failed');
    expect((await reply(db, replier, parent.id, target)).ok).toBe(true);
    expect(await notificationsOf(db)).toHaveLength(0);
  });

  it('a rolled-back comment leaves no notification', async () => {
    const { db, author, replier, parentId } = await setup();
    await expect(
      db.db.transaction(async (tx) => {
        await createComment(tx as never, { target: MAIN, userId: replier, parentId, body: 'x' });
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    expect(await notificationsOf(db, author)).toHaveLength(0);
    expect((await db.db.execute(sql`SELECT count(*)::int AS c FROM market_comments`)) as unknown).toMatchObject({ rows: [{ c: 1 }] });
  });
});
