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
    state.stored.add(state.putUrl);
    return { url: state.putUrl };
  },
  del: async (url: string) => {
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
