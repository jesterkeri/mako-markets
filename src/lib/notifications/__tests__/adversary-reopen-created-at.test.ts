// #214 S1 adversary on 0fb82ea: a re-opened reply row keeps its old created_at.
//
// Contract (NOTIFICATIONS_PLAN r8):
//   §3.2(3) "[r4] The rule for a re-opened reply row. A row that was read and then gets a new reply is re-opened as a
//      new item: count 1, read_at NULL, created_at and event_at now, and email_id NULL."
//   §3.6 "The last step of the notify route deletes ... notifications older than 90 days."
//   §3.5 GET /api/notifications: "limit 1 to 30 (10 for the panel, 20 for the page)", newest first.
//
// 0fb82ea stopped moving created_at on re-open (to keep "Load more" stable). created_at is also the prune's age and
// the feed's order, so a re-opened row is now treated as old by both. Setup: the real reply upsert, the real feed route
// and the real /api/cron/notify prune, on pglite with every migration. Only the session and the two scans are stubbed
// (the scans are not under test here; the prune is the route's last step and runs after them).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ db: null as unknown, session: null as unknown }));
vi.mock('@/db/client', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('@/lib/user-session', () => ({ getUserSession: async () => state.session }));
vi.mock('@/lib/leaderboard/indexer', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/leaderboard/indexer')>();
  return { ...real, runLeaderboardIndexerOnce: async () => ({ contracts: [{ contractAddress: '0x0', mutex: 'skipped' }] }) };
});
vi.mock('@/lib/notifications/rounds-scan', () => ({ runRoundsScanOnce: async () => ({ contractAddress: '0x0', mutex: 'skipped' }) }));

import { upsertReplyNotification } from '@/lib/comments/mutations';
import { replyKey } from '@/lib/notifications/keys';
import { unreadCount } from '@/lib/notifications/unread';
import { GET as listNotifications } from '../../../app/api/notifications/route';
import { GET as notifyTick } from '../../../app/api/cron/notify/route';

import { createNotifyDb, walletAccount, type NotifyDb } from './harness';

const SECRET = 'test-cron-secret-0123456789';
const WALLET_A = '0x00000000000000000000000000000000000a000a';
const PARENT = '00000000-0000-4000-8000-000000000099';

let t: NotifyDb;
let userId: string;

beforeEach(async () => {
  t = await createNotifyDb();
  state.db = t.db;
  userId = await walletAccount(t, WALLET_A);
  state.session = { userId, authType: 'wallet', sessionId: '00000000-0000-4000-8000-000000000001' };
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await t.close();
});

/// A reply row for PARENT, created and read `ageDays` ago.
async function oldReadReplyRow(ageDays: number) {
  await t.client.query(
    `INSERT INTO notifications (user_id, kind, dedupe_key, data, event_at, created_at, read_at)
     VALUES ($1, 'reply', $2, '{"poolId":"7","count":1}'::jsonb, now() - ($3 || ' days')::interval,
             now() - ($3 || ' days')::interval, now() - ($3 || ' days')::interval)`,
    [userId, replyKey(PARENT), String(ageDays)],
  );
}

describe('a re-opened reply row (Codex S1 code review R1 F1 fix, 0fb82ea)', () => {
  it('survives the next prune: a reply that arrived a minute ago is not "older than 90 days" (plan §3.2(3), §3.6)', async () => {
    await oldReadReplyRow(100);
    // A new reply to the same parent arrives now and re-opens the row as a new, unread item.
    await upsertReplyNotification(t.db as never, userId, PARENT, '7');
    expect(await unreadCount(userId)).toBe(1);

    vi.stubEnv('CRON_SECRET', SECRET);
    const res = await notifyTick(new Request('http://x/api/cron/notify', { headers: { authorization: `Bearer ${SECRET}` } }));
    expect(res.status).toBe(200);

    // The fresh unread reply must still be there after the tick.
    expect(await unreadCount(userId)).toBe(1);
    const { rows } = await t.client.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1`, [userId]);
    expect((rows[0] as { n: number }).n).toBe(1);
  }, 30_000);

  it('is on the panel\'s first page (limit 10), newest first, as a new item (plan §3.2(3), §3.5)', async () => {
    await oldReadReplyRow(30);
    // Ten newer items the user has already read.
    for (let i = 0; i < 10; i += 1) {
      await t.client.query(
        `INSERT INTO notifications (user_id, kind, dedupe_key, data, event_at, created_at, read_at)
         VALUES ($1, 'reply', $2, $3::jsonb, now() - interval '1 day', now() - ($4 || ' hours')::interval, now())`,
        [userId, replyKey(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`), JSON.stringify({ poolId: String(i), count: 1 }), String(i + 1)],
      );
    }
    await upsertReplyNotification(t.db as never, userId, PARENT, '7');
    expect(await unreadCount(userId)).toBe(1);

    const page = (await (await listNotifications(new Request('http://x/api/notifications?limit=10'))).json()) as {
      items: { data: { poolId: string }; read: boolean }[];
    };
    // The badge says 1 unread; the panel the badge opens must show it, and mark-read-on-open must be able to clear it.
    expect(page.items[0]).toMatchObject({ data: { poolId: '7' }, read: false });
  }, 30_000);

  it('a cursor row removed between pages (prune, account cleanup) does not end the feed early (plan §3.5 keyset)', async () => {
    for (let i = 0; i < 25; i += 1) {
      await t.client.query(
        `INSERT INTO notifications (user_id, kind, dedupe_key, data, event_at, created_at)
         VALUES ($1, 'reply', $2, $3::jsonb, now(), now() - ($4 || ' seconds')::interval)`,
        [userId, replyKey(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`), JSON.stringify({ poolId: String(i), count: 1 }), String(25 - i)],
      );
    }
    type Page = { items: { id: string }[]; next: string | null };
    const p1 = (await (await listNotifications(new Request('http://x/api/notifications?limit=20'))).json()) as Page;
    // The cursor row is the last item of page one (the cursor itself now carries its boundary, not a row to look up).
    await t.client.query('DELETE FROM notifications WHERE id = $1', [p1.items[p1.items.length - 1].id]);
    const p2 = (await (await listNotifications(new Request(`http://x/api/notifications?limit=20&cursor=${encodeURIComponent(p1.next!)}`))).json()) as Page;
    // Five older rows still exist; "Load more" must not answer "end of feed" with none of them.
    expect(p2.items).toHaveLength(5);
  }, 30_000);
});
