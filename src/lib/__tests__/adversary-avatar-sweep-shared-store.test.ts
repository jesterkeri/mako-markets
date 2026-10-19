// Adversary (public profile, 63642aa): the avatar sweep set lives in the Upstash store, under one fixed key
// (`mako:avatar:sweep`), and the sweep decides "no account points at this file" from ONE database. Production and
// Preview (beta.makomarket.xyz, the staging branch) share that Upstash store (DONE.md 2026-10-13: `mako-envio-budget`
// connected Production + Preview, KV_REST_API_*) but not the database (beta = the dev database, DONE.md 2026-10-19).
// So every photo uploaded on beta is recorded in the set production's sweep reads, and production's database has no
// row pointing at it. With one Blob store behind both (assumed, not verified here: a Vercel Blob store connected to a
// project serves every environment unless it is unticked), production's sweep deletes a beta account's ACTIVE photo.
//
// Owner rule broken (spec 1): "An account must never be left pointing at a file that was deleted (its active photo
// must never break)." Spec 2: the sweep deletes stored photos "that no account points to".
//
// Each deployment imports the real routes afresh under its own environment (VERCEL_ENV, DATABASE_URL, branch), so a
// fix that scopes the set to its deployment or database passes. Only the Upstash store and the Blob store are shared,
// exactly as in the configuration above.
//
// Second test: the sweep module's own stated invariant (src/lib/avatar-sweep.ts header: "a file is either pointed at
// by its account or in the set, so it is deleted at the next sweep at most") against the Cloudflare cron that fires
// the sweep every 15 minutes (cf-worker/src/index.ts, minute % 15 === 0).
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
vi.mock('@/lib/csrf', () => ({ checkSameOrigin: () => ({ ok: true }) }));
vi.mock('@/lib/user-session', () => ({
  getUserSession: async () => ({ authType: 'magic', userId: state.userId, email: 'a@b.c', magicEoa: EOA, walletAddress: null, sessionId: 's1' }),
}));
vi.mock('@/lib/last-sign-in', () => ({ readLastSignIn: async () => null }));
vi.mock('@/lib/safe', () => ({ deriveSafeAddress: () => '0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195' }));
vi.mock('@vercel/blob', () => ({
  BlobNotFoundError: state.NotFound,
  put: async (pathname: string) => {
    const url = `https://${HOST}/${pathname}`;
    state.stored.add(url);
    return { url, pathname };
  },
  del: async (url: string) => {
    if (state.failDel.has(url)) throw new Error('blob down');
    if (!state.stored.delete(url)) throw new state.NotFound();
  },
}));

const USERS_DDL = `
  CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text, magic_eoa text, wallet_address text, display_name text,
    avatar_url text, totp_secret text, totp_enabled_at timestamptz, last_email_changed_at timestamptz
  );
`;

type Deployment = {
  client: PGlite;
  env: Record<string, string>;
};

const ENV_KEYS = ['BLOB_READ_WRITE_TOKEN', 'CRON_SECRET', 'VERCEL_ENV', 'DATABASE_URL', 'VERCEL_GIT_COMMIT_REF', 'VERCEL_URL'];
const saved: Record<string, string | undefined> = {};
let store: ReturnType<typeof fakeSweepStore>;
let prod: Deployment;
let beta: Deployment;

async function newDeployment(env: Record<string, string>): Promise<Deployment> {
  const client = new PGlite();
  await client.exec(USERS_DDL);
  return { client, env };
}

/// Fresh copies of the real routes, loaded under this deployment's environment and pointed at its database.
async function on(d: Deployment) {
  for (const [k, v] of Object.entries(d.env)) process.env[k] = v;
  state.db = drizzle(d.client, { schema });
  vi.resetModules();
  const { POST: uploadPhoto } = await import('@/app/api/user/avatar/upload/route');
  const { POST: profileUpdate } = await import('@/app/api/user/profile/update/route');
  const { GET: sweepRoute } = await import('@/app/api/cron/avatar-sweep/route');
  return {
    async upload() {
      const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#e53935' } }).png().toBuffer();
      const form = new FormData();
      form.set('avatar', new File([new Uint8Array(png)], 'me.png', { type: 'image/png' }));
      return uploadPhoto(new Request('http://localhost/api/user/avatar/upload', { method: 'POST', body: form }));
    },
    removePhoto() {
      return profileUpdate(
        new Request('http://localhost/api/user/profile/update', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ avatarUrl: null }),
        }),
      );
    },
    async sweep() {
      const res = await sweepRoute(new Request('http://localhost/api/cron/avatar-sweep', { headers: { authorization: `Bearer ${CRON_SECRET}` } }));
      expect(res.status).toBe(200);
      return (await res.json()) as { checked: number; deleted: number; kept: number; failed: number };
    },
  };
}

const rowPhoto = async (d: Deployment) =>
  (await d.client.query<{ avatar_url: string | null }>(`SELECT avatar_url FROM users WHERE id = $1`, [state.userId])).rows[0]?.avatar_url ?? null;

beforeEach(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  const shared = { BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_store123_secret', CRON_SECRET };
  prod = await newDeployment({
    ...shared,
    VERCEL_ENV: 'production',
    DATABASE_URL: 'postgres://prod.invalid/neondb',
    VERCEL_GIT_COMMIT_REF: 'main',
    VERCEL_URL: 'mako-markets-prod.vercel.app',
  });
  beta = await newDeployment({
    ...shared,
    VERCEL_ENV: 'preview',
    DATABASE_URL: 'postgres://dev.invalid/neondb',
    VERCEL_GIT_COMMIT_REF: 'staging',
    VERCEL_URL: 'mako-markets-beta.vercel.app',
  });
  // One Upstash store behind both deployments, as configured (Production + Preview).
  store = fakeSweepStore();
  state.sweep = store;
  state.stored.clear();
  state.failDel.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await prod.client.close();
  await beta.client.close();
});

describe('adversary: the sweep set is shared by deployments that do not share a database', () => {
  it('a photo uploaded on beta survives the production sweep while the beta account points at it', async () => {
    // A beta tester (an account in the beta database only) uploads a photo.
    state.userId = (await beta.client.query<{ id: string }>(`INSERT INTO users (email, magic_eoa) VALUES ('t@b.c', $1) RETURNING id`, [EOA])).rows[0].id;
    const betaApp = await on(beta);
    expect((await betaApp.upload()).status).toBe(200);
    const active = await rowPhoto(beta);
    expect(active).not.toBeNull();
    expect(state.stored.has(active!)).toBe(true);

    // The next production cron tick, past the grace.
    store.now += 15 * 60_000;
    const prodApp = await on(prod);
    await prodApp.sweep();

    // The beta account still points at its photo, so the photo must still be stored.
    expect(await rowPhoto(beta)).toBe(active);
    expect(state.stored.has(active!), 'the beta account points at a file production swept').toBe(true);
  });
});

describe('adversary: the deletion bound (avatar-sweep.ts header) against the 15-minute cron', () => {
  it('a photo removed 4 minutes before a cron tick, whose immediate delete failed, is gone by the tick after (about 20 minutes)', async () => {
    state.userId = (await prod.client.query<{ id: string }>(`INSERT INTO users (email, magic_eoa) VALUES ('a@b.c', $1) RETURNING id`, [EOA])).rows[0].id;
    const old = `https://${HOST}/avatars/${state.userId}/old.webp`;
    state.stored.add(old);
    await prod.client.query(`UPDATE users SET avatar_url = $1 WHERE id = $2`, [old, state.userId]);
    const app = await on(prod);

    // The removal commits, its own delete fails (storage briefly down): only the sweep can delete the file now.
    state.failDel.add(old);
    expect((await app.removePhoto()).status).toBe(200);
    expect(await rowPhoto(prod)).toBeNull();
    state.failDel.clear();

    // The Cloudflare cron fires the sweep on minutes 0, 15, 30, 45; the removal landed 4 minutes before the next one.
    store.now += 4 * 60_000;
    await app.sweep();
    // Inside the 5-minute grace at that tick (it protects a removal still in its transaction), so it waits one more.
    expect(state.stored.has(old)).toBe(true);
    store.now += 15 * 60_000;
    await app.sweep();

    // Gone 19 minutes after the removal: the stated bound is about 20 minutes (avatar-sweep.ts header).
    expect(state.stored.has(old), 'the removed photo is still stored after the following sweep').toBe(false);
  });
});
