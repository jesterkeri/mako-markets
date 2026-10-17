// GET /api/avatar/<address> (Joshua 2026-10-17, Codex PUBLIC_PROFILE R1 M2): streams an account's own uploaded photo by
// public address, so the stored URL (whose path carries the internal id) is never sent. Real route over the
// leaderboard's PGlite harness; the Blob store is a stubbed fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { avatarVersion } from '@/lib/public-avatar';
import { createTestDb, type TestDb } from './test-db';

let currentDb: unknown;
vi.mock('@/db/client', () => ({
  get db() {
    return currentDb;
  },
}));

const { GET } = await import('@/app/api/avatar/[address]/route');

const HOST = 'store123.public.blob.vercel-storage.com';
const SAFE = '0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195';
const SAFE_LOWER = SAFE.toLowerCase();
const WALLET = '0x000000000000000000000000000000000000b22d';
const NOBODY = '0x000000000000000000000000000000000000c33e';

let t: TestDb | null = null;
let savedToken: string | undefined;
const blob = vi.fn();
const ids: Record<string, string> = {};

beforeEach(async () => {
  savedToken = process.env.BLOB_READ_WRITE_TOKEN;
  process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_store123_secret';
  blob.mockReset();
  vi.stubGlobal('fetch', blob);
  t = await createTestDb();
  currentDb = t.db;
  await t.client.exec(`
    CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text, wallet_address text, display_name text, avatar_url text);
    CREATE TABLE user_safes (user_id uuid NOT NULL, chain_id integer NOT NULL, safe_address text NOT NULL);
  `);
  ids.email = (await t.client.query<{ id: string }>(`INSERT INTO users (email) VALUES ('e@x.y') RETURNING id`)).rows[0].id;
  await t.client.query(`INSERT INTO user_safes (user_id, chain_id, safe_address) VALUES ($1, 10143, $2)`, [ids.email, SAFE]);
  ids.wallet = (await t.client.query<{ id: string }>(`INSERT INTO users (wallet_address) VALUES ($1) RETURNING id`, [WALLET])).rows[0].id;
});
afterEach(async () => {
  vi.unstubAllGlobals();
  if (savedToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
  else process.env.BLOB_READ_WRITE_TOKEN = savedToken;
  await t?.close();
  t = null;
});

const photoOf = (who: string) => `https://${HOST}/avatars/${ids[who]}/a.webp`;
const setPhoto = (who: string, url: string | null) => t!.client.query(`UPDATE users SET avatar_url = $1 WHERE id = $2`, [url, ids[who]]);
const get = (address: string, v?: string) =>
  GET(new Request(`http://localhost/api/avatar/${address}${v ? `?v=${v}` : ''}`), { params: Promise.resolve({ address }) });
const image = (bytes = 'PNGDATA', type = 'image/webp') => new Response(bytes, { status: 200, headers: { 'content-type': type } });

describe('GET /api/avatar/<address>', () => {
  it("streams the account's own photo, by its Safe in any case; the current version is cached a year", async () => {
    await setPhoto('email', photoOf('email'));
    blob.mockResolvedValueOnce(image());
    const res = await get(SAFE, avatarVersion(photoOf('email')));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('PNGDATA');
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(res.headers.get('location')).toBeNull(); // streamed, never redirected to the stored URL
    expect(blob).toHaveBeenCalledWith(photoOf('email'));
  });

  it('a stale or missing version still gets the photo, cached only a minute', async () => {
    await setPhoto('wallet', photoOf('wallet'));
    blob.mockResolvedValue(image());
    for (const v of ['000000000000', undefined]) {
      const res = await get(WALLET, v);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('public, max-age=60, s-maxage=60');
    }
  });

  it('no account, no photo, a photo on another host, or a non-image reply: 404, and only an owned photo is ever fetched', async () => {
    expect((await get(NOBODY)).status).toBe(404); // not a Mako Market account
    expect((await get(SAFE_LOWER)).status).toBe(404); // account without a photo
    await setPhoto('wallet', 'https://attacker.example/x.png');
    expect((await get(WALLET)).status).toBe(404);
    await setPhoto('wallet', `https://${HOST}/avatars/${ids.email}/a.webp`); // another account's path
    expect((await get(WALLET)).status).toBe(404);
    expect(blob).not.toHaveBeenCalled();
    await setPhoto('wallet', photoOf('wallet'));
    blob.mockResolvedValueOnce(image('<html>', 'text/html'));
    expect((await get(WALLET)).status).toBe(404);
    blob.mockResolvedValueOnce(new Response('gone', { status: 404 }));
    expect((await get(WALLET)).status).toBe(404);
  });

  it('not an address: 404 with no query and no fetch', async () => {
    currentDb = null; // any query would throw
    for (const bad of ['kemi', '0x123', `${WALLET}00`]) expect((await get(bad)).status, bad).toBe(404);
    expect(blob).not.toHaveBeenCalled();
  });
});
