// #214 S1 routes (NOTIFICATIONS_PLAN r8 §3.4, §3.5, §3.9, §4; §8 S1 adversary "IDOR", "(F6)", "(prefs route)",
// "Route"). Real migrations 0000..0020 on pglite; only the session and the same-origin check are stubbed.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ db: null as unknown, session: null as unknown, sameOrigin: true }));

vi.mock('@/db/client', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('@/lib/csrf', () => ({ checkSameOrigin: () => ({ ok: state.sameOrigin }) }));
vi.mock('@/lib/user-session', () => ({ getUserSession: async () => state.session }));

import { GET as listNotifications } from '../../../app/api/notifications/route';
import { POST as markRead } from '../../../app/api/notifications/read/route';
import { GET as getPrefs, POST as postPrefs } from '../../../app/api/user/notification-prefs/route';
import { unreadCount } from '@/lib/notifications/unread';
import { upsertReplyNotification } from '@/lib/comments/mutations';
import { replyKey } from '@/lib/notifications/keys';

import { createNotifyDb, emailAccount, walletAccount, type NotifyDb } from './harness';

const WALLET_A = '0x00000000000000000000000000000000000a000a';
const WALLET_B = '0x00000000000000000000000000000000000b000b';
const SAFE_C = '0x5AFE00000000000000000000000000000000000C';

let t: NotifyDb;
const ids: Record<string, string> = {};

beforeEach(async () => {
  t = await createNotifyDb();
  state.db = t.db;
  state.sameOrigin = true;
  ids.a = await walletAccount(t, WALLET_A);
  ids.b = await walletAccount(t, WALLET_B);
  ids.c = await emailAccount(t, SAFE_C);
});
afterEach(async () => t.close());
afterAll(() => vi.restoreAllMocks());

const as = (who: 'a' | 'b' | 'c' | null) => {
  state.session = who === null ? null : { userId: ids[who], authType: who === 'c' ? 'magic' : 'wallet', sessionId: '00000000-0000-4000-8000-000000000001' };
};

async function seed(userId: string, count: number) {
  for (let i = 0; i < count; i += 1) {
    await t.client.query(
      `INSERT INTO notifications (user_id, kind, dedupe_key, data, event_at, created_at) VALUES ($1, 'reply', $2, $3::jsonb, now(), now() - ($4 || ' seconds')::interval)`,
      [userId, `reply:${i}`, JSON.stringify({ poolId: String(i), count: 1 }), String(count - i)],
    );
  }
}

const json = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

describe('GET /api/notifications', () => {
  it('signed out gets 401', async () => {
    as(null);
    expect((await listNotifications(new Request('http://x/api/notifications'))).status).toBe(401);
  });

  it('pages newest first by keyset; B never sees A rows; no-store', async () => {
    await seed(ids.a, 25);
    as('a');
    const r1 = await listNotifications(new Request('http://x/api/notifications?limit=20'));
    expect(r1.headers.get('cache-control')).toBe('private, no-store');
    const p1 = (await r1.json()) as { items: { id: string; data: { poolId: string }; key: string }[]; next: string };
    expect(p1.items).toHaveLength(20);
    expect(p1.items[0].data.poolId).toBe('24');
    // Each item's key is the cursor that starts just below it, in feed order (the list compares them, R3 F1).
    expect(p1.items[19].key).toBe(p1.next);
    expect(p1.items.every((it, i) => it.key.endsWith(`_${it.id}`) && (i === 0 || it.key < p1.items[i - 1].key))).toBe(true);
    const p2 = (await (await listNotifications(new Request(`http://x/api/notifications?limit=20&cursor=${p1.next}`))).json()) as { items: unknown[]; next: string | null };
    expect(p2.items).toHaveLength(5);
    expect(p2.next).toBeNull();
    as('b');
    const pb = (await (await listNotifications(new Request(`http://x/api/notifications?cursor=${p1.next}`))).json()) as { items: unknown[] };
    expect(pb.items).toHaveLength(0);
  });

  it('re-opening reply rows between pages neither skips nor repeats an item (Codex S1 code review R1 F1)', async () => {
    const parent = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    for (let i = 0; i < 25; i += 1) {
      await t.client.query(
        `INSERT INTO notifications (user_id, kind, dedupe_key, data, event_at, created_at, read_at)
         VALUES ($1, 'reply', $2, $3::jsonb, now(), now() - ($4 || ' seconds')::interval, now())`,
        [ids.a, replyKey(parent(i)), JSON.stringify({ poolId: String(i), count: 1 }), String(25 - i)],
      );
    }
    as('a');
    type Page = { items: { id: string; data: { poolId: string }; read: boolean }[]; next: string | null };
    const p1 = (await (await listNotifications(new Request('http://x/api/notifications?limit=20'))).json()) as Page;
    // Re-open (a) a row on the next page and (b) the cursor row itself, as new replies to those parents would.
    const cursorPool = p1.items[p1.items.length - 1].data.poolId;
    await upsertReplyNotification(t.db as never, ids.a, parent(0), '0');
    await upsertReplyNotification(t.db as never, ids.a, parent(Number(cursorPool)), cursorPool);
    const p2 = (await (await listNotifications(new Request(`http://x/api/notifications?limit=20&cursor=${encodeURIComponent(p1.next!)}`))).json()) as Page;
    const all = [...p1.items, ...p2.items].map((i) => i.data.poolId);
    // Nothing repeats, and every row that did not move appears exactly once across the two pages.
    expect(new Set(all).size).toBe(all.length);
    const moved = new Set(['0', cursorPool]);
    const stayed = Array.from({ length: 25 }, (_, i) => String(i)).filter((x) => !moved.has(x));
    for (const x of stayed) expect(all.filter((y) => y === x)).toHaveLength(1);
    // The re-opened rows rose to the top as new, unread items (plan §3.2(3)): a fresh first page starts with them.
    const fresh = (await (await listNotifications(new Request('http://x/api/notifications?limit=20'))).json()) as Page;
    expect(new Set(fresh.items.slice(0, 2).map((i) => i.data.poolId))).toEqual(moved);
    expect(fresh.items.slice(0, 2).every((i) => !i.read)).toBe(true);
  });

  it('a bad limit or cursor is a 400', async () => {
    as('a');
    for (const q of ['limit=0', 'limit=31', 'limit=x', 'cursor=nope', 'cursor=00000000-0000-4000-8000-000000000001', 'cursor=2026-13-45T00:00:00.000000Z_00000000-0000-4000-8000-000000000001']) {
      expect((await listNotifications(new Request(`http://x/api/notifications?${q}`))).status).toBe(400);
    }
  });

  it('the response carries no email, user id or account address', async () => {
    await seed(ids.c, 2);
    as('c');
    const text = await (await listNotifications(new Request('http://x/api/notifications'))).text();
    expect(text).not.toContain(ids.c);
    expect(text.toLowerCase()).not.toContain(SAFE_C.toLowerCase());
    expect(text).not.toContain('@example.com');
  });
});

describe('POST /api/notifications/read', () => {
  it('marks exactly the ids shown; an item inserted after the GET stays unread', async () => {
    await seed(ids.a, 3);
    as('a');
    const page = (await (await listNotifications(new Request('http://x/api/notifications'))).json()) as { items: { id: string }[] };
    await t.client.query(`INSERT INTO notifications (user_id, kind, dedupe_key, data, event_at) VALUES ($1, 'reply', 'reply:late', '{"poolId":"9","count":1}', now())`, [ids.a]);
    const res = await markRead(new Request('http://x/api/notifications/read', json({ ids: page.items.map((i) => i.id) })));
    expect(await res.json()).toEqual({ updated: 3 });
    expect(await unreadCount(ids.a)).toBe(1);
  });

  it("B posting A's ids changes nothing", async () => {
    await seed(ids.a, 2);
    const aIds = (await t.client.query<{ id: string }>(`SELECT id FROM notifications`)).rows.map((r) => r.id);
    as('b');
    expect(await (await markRead(new Request('http://x/api/notifications/read', json({ ids: aIds })))).json()).toEqual({ updated: 0 });
    expect(await unreadCount(ids.a)).toBe(2);
  });

  it('more than 30 ids, a non-uuid, an empty list, cross-origin or signed out are refused', async () => {
    as('a');
    const many = Array.from({ length: 31 }, () => '00000000-0000-4000-8000-000000000000');
    for (const body of [{ ids: many }, { ids: ['x'] }, { ids: [] }, {}]) {
      expect((await markRead(new Request('http://x/api/notifications/read', json(body)))).status).toBe(400);
    }
    state.sameOrigin = false;
    expect((await markRead(new Request('http://x/api/notifications/read', json({ ids: [many[0]] })))).status).toBe(403);
    state.sameOrigin = true;
    as(null);
    expect((await markRead(new Request('http://x/api/notifications/read', json({ ids: [many[0]] })))).status).toBe(401);
  });
});

describe('/api/user/notification-prefs', () => {
  it('GET returns the effective switches for the own account, 409 for another account, 401 signed out', async () => {
    as('c');
    const ok = (await (await getPrefs(new Request(`http://x/api/user/notification-prefs?account=${SAFE_C}`))).json()) as { prefs: { kinds: Record<string, boolean> } };
    expect(ok.prefs.kinds).toMatchObject({ claim: true, result: true, reply: true, round_start: false });
    expect((await getPrefs(new Request(`http://x/api/user/notification-prefs?account=${WALLET_A}`))).status).toBe(409);
    as(null);
    expect((await getPrefs(new Request(`http://x/api/user/notification-prefs?account=${SAFE_C}`))).status).toBe(401);
  });

  it('POST over SQL NULL and over the two-kinds-off value switches reply off and keeps the rest', async () => {
    as('a');
    const r1 = (await (await postPrefs(new Request('http://x', json({ account: WALLET_A, kinds: { reply: false } })))).json()) as { prefs: { kinds: Record<string, boolean> } };
    expect(r1.prefs.kinds).toMatchObject({ reply: false, claim: true, result: true });
    await t.client.query(`UPDATE users SET notification_prefs = '{"kinds":{"claim":false,"result":false}}' WHERE id = $1`, [ids.a]);
    const r2 = (await (await postPrefs(new Request('http://x', json({ account: WALLET_A, kinds: { reply: false } })))).json()) as { prefs: { kinds: Record<string, boolean> } };
    expect(r2.prefs.kinds).toMatchObject({ reply: false, claim: false, result: false });
  });

  it('an unknown kind, a non-boolean, no field or an extra key is a 400 and writes nothing', async () => {
    as('a');
    for (const body of [
      { account: WALLET_A, kinds: { nope: false } },
      { account: WALLET_A, kinds: { reply: 'no' } },
      { account: WALLET_A },
      { account: WALLET_A, kinds: { reply: false }, extra: 1 },
      { account: 'x', kinds: { reply: false } },
    ]) {
      expect((await postPrefs(new Request('http://x', json(body)))).status).toBe(400);
    }
    expect((await t.client.query(`SELECT notification_prefs FROM users WHERE id = $1`, [ids.a])).rows[0]).toEqual({ notification_prefs: null });
  });

  it("another account's address is a 409; cross-origin a 403; the throttle stops the 21st write in a minute", async () => {
    as('a');
    expect((await postPrefs(new Request('http://x', json({ account: WALLET_B, kinds: { reply: false } })))).status).toBe(409);
    state.sameOrigin = false;
    expect((await postPrefs(new Request('http://x', json({ account: WALLET_A, kinds: { reply: false } })))).status).toBe(403);
    state.sameOrigin = true;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-22T12:00:10Z')); // all 21 writes inside one minute window
    try {
      let last = 0;
      for (let i = 0; i < 21; i += 1) last = (await postPrefs(new Request('http://x', json({ account: WALLET_A, kinds: { reply: i % 2 === 0 } })))).status;
      expect(last).toBe(429);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('unread count (/api/user/me)', () => {
  it('counts unread rows, capped at 100', async () => {
    await seed(ids.a, 3);
    expect(await unreadCount(ids.a)).toBe(3);
    await seed(ids.b, 105);
    expect(await unreadCount(ids.b)).toBe(100);
  });

  it('a failing count answers null and never throws', async () => {
    state.db = { execute: async () => { throw new Error('db down'); } };
    expect(await unreadCount(ids.a)).toBeNull();
  });
});
