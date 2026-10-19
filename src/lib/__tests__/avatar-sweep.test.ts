// The avatar sweep (Codex PUBLIC_PROFILE R4 F1, owner decision Q-D 2026-10-19): deletes files in the "check these
// files" set that no account points at, once they are past the 5-minute grace, and never a file an account points at.
// Real sweep route and module over PGlite; the Blob store and the Upstash set are faked.
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import { fakeSweepStore } from './helpers/fake-avatar-sweep';

const HOST = 'store123.public.blob.vercel-storage.com';
const CRON_SECRET = 'cron-secret-for-tests-only-0123456789';

const state = vi.hoisted(() => ({
  db: null as unknown,
  stored: new Set<string>(),
  deletes: [] as string[],
  failDel: new Set<string>(),
  sweep: null as unknown as { upstash: (args: (string | number)[]) => Promise<unknown> },
  NotFound: class extends Error {},
}));
vi.mock('@/db/client', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('@/lib/envio-budget', () => ({ upstashCommand: (args: (string | number)[]) => state.sweep.upstash(args) }));
vi.mock('@vercel/blob', () => ({
  BlobNotFoundError: state.NotFound,
  del: async (url: string) => {
    state.deletes.push(url);
    if (state.failDel.has(url)) throw new Error('blob down');
    if (!state.stored.delete(url)) throw new state.NotFound();
  },
}));

const { GET } = await import('@/app/api/cron/avatar-sweep/route');
const { GRACE_MS, SWEEP_BATCH, SWEEP_BUDGET_MS, sweepAvatars } = await import('@/lib/avatar-sweep');

let client: PGlite;
let store: ReturnType<typeof fakeSweepStore>;
let userId = '';
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  client = new PGlite();
  await client.exec(`CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), avatar_url text);`);
  userId = (await client.query<{ id: string }>(`INSERT INTO users DEFAULT VALUES RETURNING id`)).rows[0].id;
  state.db = drizzle(client, { schema });
  store = fakeSweepStore();
  state.sweep = store;
  state.stored.clear();
  state.deletes.length = 0;
  state.failDel.clear();
  for (const k of ['BLOB_READ_WRITE_TOKEN', 'CRON_SECRET']) saved[k] = process.env[k];
  process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_store123_secret';
  process.env.CRON_SECRET = CRON_SECRET;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await client.close();
});

const path = (name: string) => `avatars/${userId}/${name}.webp`;
const url = (name: string) => `https://${HOST}/${path(name)}`;
/// A stored file, marked in the set at the store's current time.
function file(name: string) {
  state.stored.add(url(name));
  store.members.set(path(name), store.now);
}
const sweep = (auth = `Bearer ${CRON_SECRET}`) => GET(new Request('http://localhost/api/cron/avatar-sweep', { headers: { authorization: auth } }));

// The sweep set is named per environment (avatar-sweep.ts sweepKey), so the module needs one configured.
beforeEach(() => vi.stubEnv('AVATAR_SWEEP_SCOPE', 'test'));
afterEach(() => vi.unstubAllEnvs());

describe('GET /api/cron/avatar-sweep', () => {
  it('cron auth exactly like the other cron routes: no or a wrong bearer is a 403 and touches nothing', async () => {
    file('a');
    store.now += GRACE_MS + 1;
    for (const auth of ['', 'Bearer nope', CRON_SECRET]) expect((await sweep(auth)).status).toBe(403);
    expect(state.deletes).toEqual([]);
    expect(store.members.size).toBe(1);
  });

  it('the 5-minute grace: a file added less than 5 minutes ago is left alone, at 5 minutes it is deleted', async () => {
    file('a');
    store.now += GRACE_MS - 1;
    expect(await (await sweep()).json()).toEqual({ ok: true, checked: 0, deleted: 0, kept: 0, failed: 0, invalid: 0, complete: true });
    expect(state.stored.has(url('a'))).toBe(true);
    store.now += 1;
    expect(await (await sweep()).json()).toEqual({ ok: true, checked: 1, deleted: 1, kept: 0, failed: 0, invalid: 0, complete: true });
    expect(state.stored.size).toBe(0);
    expect(store.members.size).toBe(0);
  });

  it('never deletes a file an account points at, whatever the case of the stored URL; the member is just taken off', async () => {
    file('a');
    file('b');
    await client.query(`UPDATE users SET avatar_url = $1 WHERE id = $2`, [url('a'), userId]);
    const other = (await client.query<{ id: string }>(`INSERT INTO users (avatar_url) VALUES ($1) RETURNING id`, [url('b').replace(HOST, HOST.toUpperCase())])).rows[0].id;
    expect(other).toBeTruthy();
    store.now += GRACE_MS;
    expect(await (await sweep()).json()).toMatchObject({ checked: 2, deleted: 0, kept: 2 });
    expect(state.deletes).toEqual([]);
    expect([...state.stored].sort()).toEqual([url('a'), url('b')].sort());
    expect(store.members.size).toBe(0);
  });

  it('a file already gone counts as deleted; a delete that fails stays in the set and goes at a later sweep', async () => {
    store.members.set(path('gone'), store.now);
    file('stuck');
    state.failDel.add(url('stuck'));
    store.now += GRACE_MS;
    expect(await (await sweep()).json()).toMatchObject({ checked: 2, deleted: 1, failed: 1 });
    expect([...store.members.keys()]).toEqual([path('stuck')]);
    state.failDel.clear();
    // The failed file went to the back of the set: not due again until its grace has passed once more.
    expect(await (await sweep()).json()).toMatchObject({ checked: 0, complete: true });
    store.now += GRACE_MS;
    expect(await (await sweep()).json()).toMatchObject({ checked: 1, deleted: 1, failed: 0 });
    expect(state.stored.size).toBe(0);
    expect(store.members.size).toBe(0);
  });

  it('a member marked again while the sweep runs stays for the next sweep (removed only at the score it read)', async () => {
    file('a');
    await client.query(`UPDATE users SET avatar_url = $1 WHERE id = $2`, [url('a'), userId]);
    store.now += GRACE_MS;
    // A removal of A records it again between the sweep's read and its removal of the member.
    const upstash = store.upstash;
    store.upstash = async (args) => {
      if (String(args[1]).includes('ZREM')) {
        store.now += 1;
        store.members.set(path('a'), store.now);
      }
      return upstash(args);
    };
    await sweep();
    store.upstash = upstash;
    expect(store.members.has(path('a'))).toBe(true);
    expect(state.stored.has(url('a'))).toBe(true);
  });

  it('a member that is not one of this app\'s avatar pathnames is dropped without any delete', async () => {
    store.members.set('../etc/passwd', store.now);
    store.members.set('uploads/x.webp', store.now);
    store.now += GRACE_MS;
    expect(await (await sweep()).json()).toMatchObject({ checked: 2, deleted: 0, invalid: 2 });
    expect(state.deletes).toEqual([]);
    expect(store.members.size).toBe(0);
  });

  it(`one run clears more than ${SWEEP_BATCH} (Codex R5 F1)`, async () => {
    for (let i = 0; i < SWEEP_BATCH + 5; i++) {
      file(`f${i}`);
      store.now += 1;
    }
    store.now += GRACE_MS;
    expect(await (await sweep()).json()).toMatchObject({ checked: SWEEP_BATCH + 5, deleted: SWEEP_BATCH + 5, complete: true });
    expect(store.members.size).toBe(0);
    expect(state.stored.size).toBe(0);
  });

  it(`a removed photo behind more than ${SWEEP_BATCH} older failing deletes is still deleted in that run; the failures are reported (Codex R5 F1)`, async () => {
    for (let i = 0; i <= SWEEP_BATCH; i++) {
      file(`stuck${i}`);
      state.failDel.add(url(`stuck${i}`));
      store.now += 1;
    }
    file('removed');
    store.now += GRACE_MS;
    // Failed deletes leave the run incomplete, so the route reports them (adversary on f2b9a02).
    expect(await (await sweep()).json()).toMatchObject({ checked: SWEEP_BATCH + 2, deleted: 1, failed: SWEEP_BATCH + 1, complete: false });
    expect(state.stored.has(url('removed'))).toBe(false);
    // The failures stay for the next run, each tried once in this one.
    expect(store.members.size).toBe(SWEEP_BATCH + 1);
    expect(state.deletes.filter((u) => u === url('stuck0'))).toHaveLength(1);
  });

  it('a run stops at its time budget and reports the backlog; the route logs it as an error (Codex R5 F1)', async () => {
    for (let i = 0; i < SWEEP_BATCH * 2; i++) {
      file(`f${i}`);
      store.now += 1;
    }
    store.now += GRACE_MS;
    let t = 0;
    const clock = () => (t += SWEEP_BUDGET_MS); // the budget is spent after the first batch
    expect(await sweepAvatars(clock)).toMatchObject({ checked: SWEEP_BATCH, deleted: SWEEP_BATCH, complete: false });
    expect(store.members.size).toBe(SWEEP_BATCH);
    let d = 0;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => (d += SWEEP_BUDGET_MS));
    for (let i = 0; i < SWEEP_BATCH + 1; i++) {
      file(`g${i}`);
      store.now += 1;
    }
    store.now += GRACE_MS;
    const body = await (await sweep()).json();
    spy.mockRestore();
    expect(body).toMatchObject({ complete: false });
    expect(console.error).toHaveBeenCalledWith('[cron/avatar-sweep] run left files due', expect.objectContaining({ complete: false }));
  });

  it('no AVATAR_SWEEP_SCOPE, or a malformed one: 500 and nothing deleted (Codex R5 F2)', async () => {
    file('a');
    store.now += GRACE_MS;
    vi.stubEnv('AVATAR_SWEEP_SCOPE', '');
    expect((await sweep()).status).toBe(500);
    vi.stubEnv('AVATAR_SWEEP_SCOPE', 'Prod/../x');
    expect((await sweep()).status).toBe(500);
    vi.stubEnv('AVATAR_SWEEP_SCOPE', 'test');
    expect(state.deletes).toEqual([]);
  });

  it('no Blob host (token missing) or the set store down: 500 and nothing deleted', async () => {
    file('a');
    store.now += GRACE_MS;
    delete process.env.BLOB_READ_WRITE_TOKEN;
    expect((await sweep()).status).toBe(500);
    process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_store123_secret';
    store.down = true;
    expect((await sweep()).status).toBe(500);
    expect(state.deletes).toEqual([]);
    expect(state.stored.has(url('a'))).toBe(true);
  });
});
