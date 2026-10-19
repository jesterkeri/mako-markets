// Adversary (public profile, 7ead089), reworked for Codex PUBLIC_PROFILE R4 F1 (owner decision Q-D, 2026-10-19):
// removing and replacing a photo while other requests from the same account land, and while storage or the sweep store
// fail. The owner's rules: a removed or replaced photo is deleted from storage within about 15 minutes, guaranteed; the
// active photo is never broken by a failure. So after ANY interleaving or failure below, plus one sweep run once the
// grace has passed, the Blob store holds exactly the file the account points at, and that file exists.
//
// Both real routes and the real sweep route run over PGlite; only the Blob store, the Upstash sweep set, session, CSRF
// and last-sign-in lookups are faked.
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import { fakeSweepStore } from './helpers/fake-avatar-sweep';

const HOST = 'store123.public.blob.vercel-storage.com';
const EOA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CRON_SECRET = 'cron-secret-for-tests-only-0123456789';

const state = vi.hoisted(() => ({
  db: null as unknown,
  userId: '',
  stored: new Set<string>(),
  puts: [] as string[],
  // A URL here fails its deletes until removed.
  failDel: new Set<string>(),
  failPut: false,
  // The next put stores the file but its answer is lost (throws after storing).
  loseNextPutAnswer: false,
  // Gates: a put (by call number, 1-based) or a delete (by URL) waits for its gate.
  putGates: new Map<number, Promise<void>>(),
  delGates: new Map<string, Promise<void>>(),
  sweep: null as unknown as { upstash: (args: (string | number)[]) => Promise<unknown> },
  NotFound: class extends Error {},
}));

vi.mock('@/db/client', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('@/lib/envio-budget', () => ({ upstashCommand: (args: (string | number)[]) => state.sweep.upstash(args) }));
vi.mock('@/lib/csrf', () => ({ checkSameOrigin: () => ({ ok: true }) }));
vi.mock('@/lib/user-session', () => ({
  getUserSession: async () => ({ authType: 'magic', userId: state.userId, email: 'a@b.c', magicEoa: EOA, walletAddress: null, sessionId: 's1' }),
}));
vi.mock('@/lib/last-sign-in', () => ({ readLastSignIn: async () => null }));
vi.mock('@/lib/safe', () => ({ deriveSafeAddress: () => '0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195' }));
vi.mock('@vercel/blob', () => ({
  BlobNotFoundError: state.NotFound,
  put: async (pathname: string, _body: unknown, opts: { addRandomSuffix?: boolean }) => {
    const n = state.puts.push(pathname);
    await state.putGates.get(n);
    if (state.failPut) throw new Error('blob down');
    if (opts.addRandomSuffix !== false) throw new Error('test expects addRandomSuffix: false');
    const url = `https://${HOST}/${pathname}`;
    state.stored.add(url);
    if (state.loseNextPutAnswer) {
      state.loseNextPutAnswer = false;
      throw new Error('socket hang up');
    }
    return { url, pathname };
  },
  del: async (url: string) => {
    await state.delGates.get(url);
    if (state.failDel.has(url)) throw new Error('blob down');
    if (!state.stored.delete(url)) throw new state.NotFound();
  },
}));

const { POST: profileUpdate } = await import('@/app/api/user/profile/update/route');
const { POST: uploadPhoto } = await import('@/app/api/user/avatar/upload/route');
const { GET: sweepRoute } = await import('@/app/api/cron/avatar-sweep/route');
const { GRACE_MS } = await import('@/lib/avatar-sweep');

let client: PGlite;
let store: ReturnType<typeof fakeSweepStore>;
const saved: Record<string, string | undefined> = {};

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
  store = fakeSweepStore();
  state.sweep = store;
  state.stored.clear();
  state.puts.length = 0;
  state.failDel.clear();
  state.failPut = false;
  state.loseNextPutAnswer = false;
  state.putGates.clear();
  state.delGates.clear();
  for (const k of ['BLOB_READ_WRITE_TOKEN', 'CRON_SECRET']) saved[k] = process.env[k];
  process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_store123_secret';
  process.env.CRON_SECRET = CRON_SECRET;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});

  // The account starts on photo A, in the row and in the store.
  state.stored.add(photo('a'));
  await setRow(photo('a'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await client.close();
});

const photo = (name: string) => `https://${HOST}/avatars/${state.userId}/${name}.webp`;
const setRow = (url: string | null) => client.query(`UPDATE users SET avatar_url = $1 WHERE id = $2`, [url, state.userId]);
const rowPhoto = async () =>
  (await client.query<{ avatar_url: string | null }>(`SELECT avatar_url FROM users WHERE id = $1`, [state.userId])).rows[0].avatar_url;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
};

async function upload(): Promise<Response> {
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#e53935' } }).png().toBuffer();
  const form = new FormData();
  form.set('avatar', new File([new Uint8Array(png)], 'me.png', { type: 'image/png' }));
  return uploadPhoto(new Request('http://localhost/api/user/avatar/upload', { method: 'POST', body: form }));
}
const removePhoto = () =>
  profileUpdate(
    new Request('http://localhost/api/user/profile/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ avatarUrl: null }),
    }),
  );
/// One sweep run once every member in the set is past the grace.
async function sweepAfterGrace() {
  store.now += GRACE_MS + 1;
  const res = await sweepRoute(new Request('http://localhost/api/cron/avatar-sweep', { headers: { authorization: `Bearer ${CRON_SECRET}` } }));
  expect(res.status).toBe(200);
  return (await res.json()) as { checked: number; deleted: number; kept: number; failed: number };
}
/// The owner's rule: storage holds exactly the file the account points at, and that file exists.
async function expectStorageMatchesRow() {
  const row = await rowPhoto();
  expect({ row, stored: [...state.stored].sort() }).toEqual({ row, stored: row ? [row] : [] });
}

// The sweep set is named per environment (avatar-sweep.ts sweepKey), so the module needs one configured.
beforeEach(() => vi.stubEnv('AVATAR_SWEEP_SCOPE', 'test'));
afterEach(() => vi.unstubAllEnvs());

describe('interleavings of removal and uploads from one account', () => {
  it('a removal that lands while an upload is between its put and its row write', async () => {
    const g = gate();
    state.putGates.set(1, g.p);
    const up = upload();
    while (state.puts.length === 0) await sleep(2);
    expect((await removePhoto()).status).toBe(200); // removes A
    g.open();
    expect((await up).status).toBe(200);
    expect(await rowPhoto()).toBe(`https://${HOST}/${state.puts[0]}`);
    await sweepAfterGrace();
    await expectStorageMatchesRow();
  });

  it('every order of two uploads and a removal finishing, each sweep leaving only the current photo', async () => {
    const orders = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    for (const order of orders) {
      state.stored.clear();
      state.puts.length = 0;
      state.putGates.clear();
      state.delGates.clear();
      state.stored.add(photo('a'));
      await setRow(photo('a'));
      // Upload 1 and upload 2 wait at their puts; the removal waits at its post-commit delete of whatever it removed.
      const gates = [gate(), gate(), gate()];
      state.putGates.set(1, gates[0].p);
      state.putGates.set(2, gates[1].p);
      const u1 = upload();
      while (state.puts.length < 1) await sleep(2);
      const u2 = upload();
      while (state.puts.length < 2) await sleep(2);
      for (const url of [photo('a'), ...state.puts.map((p) => `https://${HOST}/${p}`)]) state.delGates.set(url, gates[2].p);
      const rm = removePhoto();
      for (const i of order) {
        gates[i].open();
        await sleep(20);
      }
      const statuses = (await Promise.all([u1, u2, rm])).map((r) => r.status);
      expect(statuses, `order ${order}`).toEqual([200, 200, 200]);
      await sweepAfterGrace();
      await expectStorageMatchesRow();
      expect(store.members.size, `order ${order}`).toBe(0);
    }
  });

  it('two uploads, the first one finishing last: the row keeps the last commit, the other file is swept', async () => {
    const g = gate();
    state.putGates.set(1, g.p);
    const first = upload();
    while (state.puts.length === 0) await sleep(2);
    expect((await upload()).status).toBe(200);
    g.open();
    expect((await first).status).toBe(200);
    expect(await rowPhoto()).toBe(`https://${HOST}/${state.puts[0]}`);
    await sweepAfterGrace();
    await expectStorageMatchesRow();
  });
});

describe('failures between storage, the sweep set and the database (Codex R4 F1)', () => {
  it('put stores the file but its answer is lost: 502, the account keeps A, the stored file is swept', async () => {
    state.loseNextPutAnswer = true;
    const res = await upload();
    expect(res.status).toBe(502);
    expect(await rowPhoto()).toBe(photo('a'));
    expect(state.stored.size).toBe(2); // the lost-answer file really is in storage
    const run = await sweepAfterGrace();
    expect(run.deleted).toBe(1);
    await expectStorageMatchesRow();
  });

  it('the cleanup delete of the replaced photo fails: 200, A stays until the sweep, which deletes it once storage works', async () => {
    state.failDel.add(photo('a'));
    expect((await upload()).status).toBe(200);
    expect(state.stored.has(photo('a'))).toBe(true);
    // Storage still failing at the first sweep: A is kept in the set, not lost.
    expect((await sweepAfterGrace()).failed).toBe(1);
    expect(state.stored.has(photo('a'))).toBe(true);
    state.failDel.clear();
    expect((await sweepAfterGrace()).deleted).toBe(1);
    await expectStorageMatchesRow();
  });

  it('the cleanup delete of a removed photo fails: 200, the account has no photo, the sweep deletes A', async () => {
    state.failDel.add(photo('a'));
    expect((await removePhoto()).status).toBe(200);
    expect(await rowPhoto()).toBeNull();
    state.failDel.clear();
    await sweepAfterGrace();
    await expectStorageMatchesRow();
  });

  it('the database write fails after the put: the error propagates, the account keeps A, the new file is swept', async () => {
    await client.exec(`
      CREATE FUNCTION refuse() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'database down'; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER refuse BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION refuse();
    `);
    await expect(upload()).rejects.toThrow();
    await client.exec(`DROP TRIGGER refuse ON users`);
    expect(await rowPhoto()).toBe(photo('a'));
    expect(state.stored.size).toBe(2);
    await sweepAfterGrace();
    await expectStorageMatchesRow();
  });

  it('the commit lands but its answer is lost: the error propagates, the new photo stays (referenced), A is swept', async () => {
    const db = state.db as { transaction: (...a: unknown[]) => Promise<unknown> };
    const real = db.transaction.bind(db);
    db.transaction = async (...a: unknown[]) => {
      await real(...a);
      throw new Error('connection reset after commit');
    };
    await expect(upload()).rejects.toThrow('connection reset after commit');
    db.transaction = real;
    const row = await rowPhoto();
    expect(row).toBe(`https://${HOST}/${state.puts[0]}`);
    await sweepAfterGrace();
    await expectStorageMatchesRow();
  });

  it('the sweep set down before the upload: 503, no put, nothing changed', async () => {
    store.down = true;
    const res = await upload();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'sweep_unavailable' });
    expect(state.puts).toEqual([]);
    expect(await rowPhoto()).toBe(photo('a'));
    expect([...state.stored]).toEqual([photo('a')]);
  });

  it('the sweep set down for a removal: 503, the account keeps A, nothing deleted', async () => {
    store.down = true;
    const res = await removePhoto();
    expect(res.status).toBe(503);
    expect(await rowPhoto()).toBe(photo('a'));
    expect([...state.stored]).toEqual([photo('a')]);
  });

  it('a put that fails outright: 502, nothing changed, nothing left behind', async () => {
    state.failPut = true;
    expect((await upload()).status).toBe(502);
    expect(await rowPhoto()).toBe(photo('a'));
    await sweepAfterGrace();
    await expectStorageMatchesRow();
    expect(store.members.size).toBe(0);
  });

  it('once storage works, the replacement and the removal each delete their old file at once', async () => {
    expect((await upload()).status).toBe(200);
    expect(state.stored.has(photo('a'))).toBe(false);
    await expectStorageMatchesRow();
    expect((await removePhoto()).status).toBe(200);
    expect(await rowPhoto()).toBeNull();
    expect(state.stored.size).toBe(0);
    // The sweep then finds them already gone (not found counts as done) and empties the set.
    await sweepAfterGrace();
    expect(store.members.size).toBe(0);
  });
});
