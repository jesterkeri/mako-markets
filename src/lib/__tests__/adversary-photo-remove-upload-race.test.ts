// Adversary (public profile, 7ead089): removing a photo while an upload of a new one lands.
//
// Joshua 2026-10-17, rule 3: removing a photo deletes the file from storage. POST /api/user/profile/update reads the
// current photo in one statement and clears the column in another, so an upload that lands between the two leaves the
// row cleared and the NEW file in the Blob store, deleted by nobody: the upload route deleted the old file, and the
// removal deletes the old file again. Both real routes run over PGlite; only the Blob store, session, CSRF and
// last-sign-in lookups are stubbed. The removal's photo read is held until the upload has finished, which is one
// legal interleaving of two requests from the same account (two tabs, or a double tap).
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';

const HOST = 'store123.public.blob.vercel-storage.com';
const EOA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const state = vi.hoisted(() => ({
  db: null as unknown,
  userId: '',
  stored: new Set<string>(),
  deleted: [] as string[],
  puts: [] as string[],
  failDel: new Set<string>(),
  // A URL here fails its next delete only, after waiting for its gate when one is set.
  failDelOnce: new Set<string>(),
  delGate: new Map<string, Promise<void>>(),
  delStarted: [] as string[],
  failPut: false,
  // Each put takes the next URL from here, else putUrl.
  putQueue: [] as string[],
  putUrl: '',
}));

vi.mock('@/db/client', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('@/lib/csrf', () => ({ checkSameOrigin: () => ({ ok: true }) }));
vi.mock('@/lib/user-session', () => ({
  getUserSession: async () => ({ authType: 'magic', userId: state.userId, email: 'a@b.c', magicEoa: EOA, walletAddress: null, sessionId: 's1' }),
}));
vi.mock('@/lib/last-sign-in', () => ({ readLastSignIn: async () => null }));
vi.mock('@/lib/safe', () => ({ deriveSafeAddress: () => '0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195' }));
vi.mock('@vercel/blob', () => ({
  put: async () => {
    if (state.failPut) throw new Error('blob down');
    const url = state.putQueue.shift() ?? state.putUrl;
    state.puts.push(url);
    state.stored.add(url);
    return { url };
  },
  del: async (url: string) => {
    state.delStarted.push(url);
    const gate = state.delGate.get(url);
    if (gate) {
      state.delGate.delete(url);
      await gate;
    }
    if (state.failDel.has(url)) throw new Error('blob down');
    if (state.failDelOnce.delete(url)) throw new Error('blob down');
    state.deleted.push(url);
    state.stored.delete(url);
  },
}));

const { POST: removePhoto } = await import('@/app/api/user/profile/update/route');
const { POST: uploadPhoto } = await import('@/app/api/user/avatar/upload/route');

let client: PGlite;

beforeEach(async () => {
  client = new PGlite();
  await client.exec(`
    CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text, magic_eoa text, wallet_address text, display_name text,
      avatar_url text, totp_secret text, totp_enabled_at timestamptz, last_email_changed_at timestamptz
    );
  `);
  state.userId = (await client.query<{ id: string }>(`INSERT INTO users (email, magic_eoa) VALUES ('a@b.c', $1) RETURNING id`, [EOA])).rows[0].id;
  state.db = drizzle(client, { schema });
  state.stored.clear();
  state.deleted.length = 0;
  state.puts.length = 0;
  state.failDel.clear();
  state.failDelOnce.clear();
  state.delGate.clear();
  state.delStarted.length = 0;
  state.failPut = false;
  state.putQueue.length = 0;
});
afterEach(async () => {
  await client.close();
});

const photo = (name: string) => `https://${HOST}/avatars/${state.userId}/${name}.webp`;

async function uploadRequest(): Promise<Request> {
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#e53935' } }).png().toBuffer();
  const form = new FormData();
  form.set('avatar', new File([new Uint8Array(png)], 'me.png', { type: 'image/png' }));
  return new Request('http://localhost/api/user/avatar/upload', { method: 'POST', body: form });
}

describe('removing a photo while a new one uploads', () => {
  it('leaves no photo file in storage that the account no longer points at', async () => {
    // The account has photo A, in the row and in the store.
    const a = photo('a');
    state.stored.add(a);
    await client.query(`UPDATE users SET avatar_url = $1 WHERE id = $2`, [a, state.userId]);
    state.putUrl = photo('b');

    // Hold the removal's read of the current photo until the upload has finished.
    let release!: () => void;
    const uploadDone = new Promise<void>((r) => (release = r));
    let held = false;
    const query = client.query.bind(client);
    (client as unknown as { query: typeof client.query }).query = (async (sql: string, params?: unknown[], opts?: object) => {
      const result = await query(sql, params, opts);
      if (!held && /^select "avatar_url" from "users"/i.test(sql)) {
        held = true;
        await uploadDone;
      }
      return result;
    }) as typeof client.query;

    const removal = removePhoto(
      new Request('http://localhost/api/user/profile/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ avatarUrl: null }),
      }),
    );
    // A removal that reads and clears in one statement never pauses here; the upload then simply lands after it.
    let settled = false;
    void removal.finally(() => (settled = true));
    while (!held && !settled) await new Promise((r) => setTimeout(r, 5));
    const upload = await uploadPhoto(await uploadRequest());
    expect(upload.status).toBe(200);
    release();
    await removal;

    const row = (await client.query<{ avatar_url: string | null }>(`SELECT avatar_url FROM users WHERE id = $1`, [state.userId])).rows[0];
    // Every photo file still in the store must be the one the account points at; anything else is a removed photo
    // that was never deleted, kept public at a URL whose path carries the internal account id.
    const orphans = [...state.stored].filter((url) => url !== row.avatar_url);
    expect({ row: row.avatar_url, orphans }).toEqual({ row: row.avatar_url, orphans: [] });
  });
});

// Codex PUBLIC_PROFILE R2 M1: a photo that cannot be deleted from storage must not be reported as removed or replaced.
describe('when storage cannot delete the old photo', () => {
  const rowPhoto = async () =>
    (await client.query<{ avatar_url: string | null }>(`SELECT avatar_url FROM users WHERE id = $1`, [state.userId])).rows[0].avatar_url;
  const removeRequest = () =>
    new Request('http://localhost/api/user/profile/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ avatarUrl: null }),
    });

  beforeEach(async () => {
    state.stored.add(photo('a'));
    await client.query(`UPDATE users SET avatar_url = $1 WHERE id = $2`, [photo('a'), state.userId]);
    state.putUrl = photo('b');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('a removal answers 503 and the account still points at its photo', async () => {
    state.failDel.add(photo('a'));
    const res = await removePhoto(removeRequest());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'photo_not_removed' });
    expect(await rowPhoto()).toBe(photo('a'));
    expect([...state.stored]).toEqual([photo('a')]);
  });

  it('a replacement answers 503, the account still points at the prior photo, and no new file is ever stored', async () => {
    state.failDel.add(photo('a'));
    const res = await uploadPhoto(await uploadRequest());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'photo_not_replaced' });
    expect(await rowPhoto()).toBe(photo('a'));
    expect(state.puts).toEqual([]);
    expect(state.deleted).toEqual([]);
    expect([...state.stored]).toEqual([photo('a')]);
  });

  it('a replacement whose new file cannot be stored after the old one was deleted answers 502 and clears the account', async () => {
    state.failPut = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await uploadPhoto(await uploadRequest());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'storage_unavailable' });
    expect(await rowPhoto()).toBeNull();
    expect(state.deleted).toEqual([photo('a')]);
    expect(state.stored.size).toBe(0);
  });

  // Codex PUBLIC_PROFILE R3 M1, the exact interleaving: account on A; upload B's delete of A is slow and then fails;
  // upload C arrives while it is pending. C must wait for B (the row is locked), then delete A itself and store its
  // own file. Afterwards the store holds exactly the row's current photo: A is never stranded.
  it('a failed replacement racing a second upload leaves no file but the current photo', async () => {
    let release!: () => void;
    state.delGate.set(photo('a'), new Promise<void>((r) => (release = r)));
    state.failDelOnce.add(photo('a'));
    state.putQueue.push(photo('b'), photo('c'));
    const [reqB, reqC] = [await uploadRequest(), await uploadRequest()];
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const b = uploadPhoto(reqB);
    while (!state.delStarted.includes(photo('a'))) await sleep(5);
    const c = uploadPhoto(reqC);
    await Promise.race([c, sleep(500)]); // C runs as far as it can while B's delete is pending
    release();
    const [resB, resC] = await Promise.all([b, c]);

    const row = await rowPhoto();
    expect([...state.stored]).toEqual([row]);
    expect([resB.status, resC.status]).toEqual([503, 200]);
    expect(row).toBe(photo('b')); // B never stored a file, so C's is the first put
    expect(state.deleted).toEqual([photo('a')]);
  });

  it('the same race with a removal in it too: still no file but the current photo', async () => {
    state.failDelOnce.add(photo('a'));
    state.putQueue.push(photo('b'), photo('c'));
    const [reqB, reqC] = [await uploadRequest(), await uploadRequest()];
    const results = await Promise.all([uploadPhoto(reqB), removePhoto(removeRequest()), uploadPhoto(reqC)]);
    expect(results.some((r) => r.status === 503)).toBe(true);
    const row = await rowPhoto();
    expect([...state.stored]).toEqual(row ? [row] : []);
    expect(state.stored.has(photo('a'))).toBe(false);
  });

  it('once storage works, the replacement deletes exactly the replaced file and the removal exactly the removed one', async () => {
    expect((await uploadPhoto(await uploadRequest())).status).toBe(200);
    expect(await rowPhoto()).toBe(photo('b'));
    expect(state.deleted).toEqual([photo('a')]);
    expect((await removePhoto(removeRequest())).status).toBe(200);
    expect(await rowPhoto()).toBeNull();
    expect(state.deleted).toEqual([photo('a'), photo('b')]);
    expect(state.stored.size).toBe(0);
  });
});
