// Adversary probe (2026-10-15, feat/leaderboard-avatars 56d4aef): URL tricks and precedence against
// resolveLabels' public photo gate. Invariant from the spec: any avatarUrl returned must, when a browser
// resolves it, load from THIS app's Blob host under the SAME user's /avatars/<id>/ path over https.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveStoredIdentities as resolveLabels } from '@/lib/leaderboard/identity'; // (builder: the strict photo gate now feeds /api/avatar; the public gets only its path)
import { createTestDb, type TestDb } from './test-db';

const CHAIN = 10143;
const HOST = 'store123.public.blob.vercel-storage.com';
const SAFE = '0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195';
const SAFE_LOWER = SAFE.toLowerCase();

let t: TestDb | null = null;
const saved = process.env.BLOB_READ_WRITE_TOKEN;
beforeEach(() => {
  process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_STORE123_testsecret';
});
afterEach(async () => {
  if (saved === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
  else process.env.BLOB_READ_WRITE_TOKEN = saved;
  if (t) await t.close();
  t = null;
});

async function fresh(): Promise<TestDb> {
  t = await createTestDb(); // users + user_safes stubs come from the harness (#214)
  return t;
}

async function user(db: TestDb, name: string | null, avatar: (id: string) => string | null, opts: { safe?: string; wallet?: string }) {
  const r = await db.client.query<{ id: string }>(`INSERT INTO users (email, display_name, wallet_address) VALUES ('x@example.com', $1, $2) RETURNING id`, [name, opts.wallet ?? null]);
  const id = r.rows[0].id;
  await db.client.query('UPDATE users SET avatar_url = $1 WHERE id = $2', [avatar(id), id]);
  if (opts.safe) await db.client.query('INSERT INTO user_safes (user_id, chain_id, safe_address) VALUES ($1, $2, $3)', [id, CHAIN, opts.safe]);
  return id;
}

// Userinfo (https://evil@<app host>/...) passes the gate, as it does on the comments wire; the request still goes to
// the app host only (Chrome blocks credentialed subresources), so no third party is contacted. Not asserted here.
function browserSafe(url: string, id: string): boolean {
  const u = new URL(url, 'https://makomarket.xyz/leaderboard');
  return u.protocol === 'https:' && u.hostname === HOST && u.pathname.startsWith(`/avatars/${id}/`);
}

const OTHER = '11111111-1111-1111-1111-111111111111';
const tricks: Array<[string, (id: string) => string]> = [
  ['userinfo evil@', (id) => `https://evil.example@${HOST}/avatars/${id}/1.webp`],
  ['userinfo user:pass', (id) => `https://u:p@${HOST}/avatars/${id}/1.webp`],
  ['host as userinfo, evil host', (id) => `https://${HOST}@evil.example/avatars/${id}/1.webp`],
  ['port', (id) => `https://${HOST}:8443/avatars/${id}/1.webp`],
  ['uppercase host', (id) => `https://${HOST.toUpperCase()}/avatars/${id}/1.webp`],
  ['trailing dot', (id) => `https://${HOST}./avatars/${id}/1.webp`],
  ['raw traversal', (id) => `https://${HOST}/avatars/${id}/../${OTHER}/1.webp`],
  ['encoded traversal', (id) => `https://${HOST}/avatars/${id}/%2e%2e/${OTHER}/1.webp`],
  ['encoded slash', (id) => `https://${HOST}/avatars/${id}/..%2F${OTHER}/1.webp`],
  ['backslashes', (id) => `https:\\\\${HOST}\\avatars\\${id}\\1.webp`],
  ['leading whitespace', (id) => `  https://${HOST}/avatars/${id}/1.webp`],
  ['tab in host', (id) => `https://store123.pub\tlic.blob.vercel-storage.com/avatars/${id}/1.webp`],
  ['protocol-relative', (id) => `//${HOST}/avatars/${id}/1.webp`],
  ['javascript', (id) => `javascript:alert(1)//${HOST}/avatars/${id}/`],
  ['data', (id) => `data:image/svg+xml,<svg/>#https://${HOST}/avatars/${id}/`],
  ['fragment host', (id) => `https://evil.example#${HOST}/avatars/${id}/`],
  ['query host', (id) => `https://evil.example?${HOST}/avatars/${id}/`],
  ['id prefix of a longer id', (id) => `https://${HOST}/avatars/${id}x/1.webp`],
  ['uppercase id', (id) => `https://${HOST}/avatars/${id.toUpperCase()}/1.webp`],
  ['IDN fullwidth dot', (id) => `https://store123．public.blob.vercel-storage.com/avatars/${id}/1.webp`],
];

describe('adversary: photo URL tricks', () => {
  it.each(tricks)('%s: returned photo (if any) loads from the app host, own path', async (_n, mk) => {
    const db = await fresh();
    const id = await user(db, 'kemi', mk, { safe: SAFE });
    const got = (await resolveLabels(db.db as never, [SAFE_LOWER], CHAIN)).get(SAFE_LOWER)?.avatarUrl ?? null;
    if (got !== null) expect(browserSafe(got, id), got).toBe(true);
  });
});

describe('adversary: precedence never mixes one user name with another user photo', () => {
  it('named safe user without photo vs unnamed wallet user with owned photo on the same address', async () => {
    const db = await fresh();
    await user(db, 'named', () => null, { safe: SAFE });
    await user(db, null, (id) => `https://${HOST}/avatars/${id}/1.webp`, { wallet: SAFE_LOWER });
    expect((await resolveLabels(db.db as never, [SAFE_LOWER], CHAIN)).get(SAFE_LOWER)).toEqual({ displayName: 'named', avatarUrl: null, branch: 'safe' });
  });
  it('photo of the winning user is only ever that user\'s own', async () => {
    const db = await fresh();
    const a = await user(db, null, () => null, { safe: SAFE });
    await user(db, null, () => `https://${HOST}/avatars/${a}/1.webp`, { wallet: SAFE_LOWER });
    const got = (await resolveLabels(db.db as never, [SAFE_LOWER], CHAIN)).get(SAFE_LOWER);
    expect(got?.avatarUrl ?? null).toBeNull();
  });
});
