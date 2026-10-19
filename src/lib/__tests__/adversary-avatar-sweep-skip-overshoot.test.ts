// Adversary (public profile, f2b9a02): the draining sweep (src/lib/avatar-sweep.ts sweepAvatars) skips, on each later
// read, the members it "left in place this run" by counting them in `left`. It counts an unmark as left in place
// whenever upstashCommand THROWS. A throw does not mean the write did not happen: a request that times out after Redis
// ran the script (the answer is lost on the way back) has removed the member, yet the run still counts it. The next
// read then skips one member too many, so a due file behind the first batch is never looked at, and because that read
// comes back short the run reports `complete: true`. The route therefore logs no error, and the file waits a whole
// extra cadence (about 35 minutes instead of about 20).
//
// Spec 1 (brief): "a run that cannot clear it reports `complete: false` and the route logs it as an error."
// Spec 4 (brief): "skipping members it left in place this run (failed deletes, failed unmarks) so it neither loops on
// them nor misses newer due files behind them".
//
// Second test: a failed delete is a due file the run did not clear, yet the run reports `complete: true` and the route
// logs no error (the existing suite asserts complete: true here; the spec sentence above says otherwise). Ranked lower:
// it depends on reading "cannot clear it" as covering storage failures, not only the time budget.
//
// Real sweep route and module over PGlite; the Blob store and the Upstash set are faked exactly as in
// avatar-sweep.test.ts.
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
    if (state.failDel.has(url)) throw new Error('blob down');
    if (!state.stored.delete(url)) throw new state.NotFound();
  },
}));

const { GET } = await import('@/app/api/cron/avatar-sweep/route');
const { GRACE_MS, SWEEP_BATCH } = await import('@/lib/avatar-sweep');

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
  state.failDel.clear();
  for (const k of ['BLOB_READ_WRITE_TOKEN', 'CRON_SECRET']) saved[k] = process.env[k];
  process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_store123_secret';
  process.env.CRON_SECRET = CRON_SECRET;
  vi.stubEnv('AVATAR_SWEEP_SCOPE', 'test');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await client.close();
});

const path = (name: string) => `avatars/${userId}/${name}.webp`;
const url = (name: string) => `https://${HOST}/${path(name)}`;
function file(name: string) {
  state.stored.add(url(name));
  store.members.set(path(name), store.now);
}
const sweep = () => GET(new Request('http://localhost/api/cron/avatar-sweep', { headers: { authorization: `Bearer ${CRON_SECRET}` } }));

describe('adversary: the draining sweep skip count', () => {
  it('an unmark whose answer is lost after Redis ran it makes the run skip a due file it never checked, yet report complete', async () => {
    // One more due file than a batch holds, all deletable, none referenced.
    for (let i = 0; i < SWEEP_BATCH + 1; i++) {
      file(`f${String(i).padStart(3, '0')}`);
      store.now += 1;
    }
    store.now += GRACE_MS;

    // The unmark of the first member runs in Redis, then the HTTP answer is lost (timeout after the write).
    const victim = path('f000');
    const upstash = store.upstash;
    let lost = false;
    store.upstash = async (args) => {
      const out = await upstash(args);
      if (!lost && String(args[1]).includes('ZREM') && String(args[4]) === victim) {
        lost = true;
        throw new Error('upstash timeout after write');
      }
      return out;
    };

    const res = await sweep();
    const body = await res.json();
    expect(lost).toBe(true);

    // Every due file is still deletable, so one run can clear them all. If it does not, it must say so.
    const leftDue = [...state.stored];
    expect({ complete: body.complete, leftDue }).toEqual(
      body.complete ? { complete: true, leftDue: [] } : { complete: false, leftDue },
    );
  });

  it('a delete that fails leaves a due file uncleared, yet the run reports complete and the route logs no error', async () => {
    file('stuck');
    state.failDel.add(url('stuck'));
    store.now += GRACE_MS;

    const body = await (await sweep()).json();
    expect(body).toMatchObject({ failed: 1 });
    expect(state.stored.has(url('stuck'))).toBe(true);
    // The run could not clear what is due, so it must not claim it did, and the route must log it as an error.
    expect(body.complete).toBe(false);
    expect(console.error).toHaveBeenCalled();
  });
});
