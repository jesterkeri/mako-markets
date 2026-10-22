// ----------------------------------------------------------------------------
// #186 Leaderboard identity resolver — the casing-mismatch regression
// suite.
//
// The production columns store DIFFERENT casings (verified in code):
// user_safes.safe_address is CHECKSUMMED (safe.ts:154 via getAddress),
// users.wallet_address is lowercase (user-upsert.ts:178). The ledger's
// actor is lowercase. These tests insert a CHECKSUMMED safe address —
// exactly as prod does — and assert the lowercase actor still resolves.
//
// The harness adds a MINIMAL mirror of users/user_safes (only the
// columns the resolver touches); inserts go through raw SQL because
// Drizzle's insert builder enumerates every schema column (the full
// users table has ~15 the mirror deliberately lacks). The resolver's
// own SELECTs use explicit projections, so they run fine against the
// mirror. Real constraints live in the real migrations.
// ----------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveLabels, resolveStoredIdentities } from '@/lib/leaderboard/identity';
import { publicAvatarPath } from '@/lib/public-avatar';
import { createTestDb, type TestDb } from './test-db';

const CHAIN = 10143;

// Prod-realistic: checksummed safe (what deriveSafeAddress returns),
// lowercase actor (what the ledger stores).
const SAFE_CHECKSUMMED = '0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195';
const SAFE_LOWER = SAFE_CHECKSUMMED.toLowerCase();
const WALLET_LOWER = '0xc8bf886f73e4371cbd8160eea7683b8da98190f1';

let testDb: TestDb | null = null;

afterEach(async () => {
  if (testDb) {
    await testDb.close();
    testDb = null;
  }
});

async function freshDb(): Promise<TestDb> {
  testDb = await createTestDb();
  // Minimal mirror of the identity tables (resolver-touched columns
  // only).
  await testDb.client.exec(`
    CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text,
      wallet_address text,
      display_name text,
      avatar_url text
    );
    CREATE TABLE user_safes (
      user_id uuid NOT NULL,
      chain_id integer NOT NULL,
      safe_address text NOT NULL
    );
  `);
  return testDb;
}

async function insertMagicUser(
  t: TestDb,
  opts: { displayName: string | null; safeAddress: string; chainId?: number },
): Promise<string> {
  const res = await t.client.query<{ id: string }>(
    `INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id`,
    ['IGNORED-never-selected@example.com', opts.displayName],
  );
  const id = res.rows[0].id;
  await t.client.query(
    `INSERT INTO user_safes (user_id, chain_id, safe_address) VALUES ($1, $2, $3)`,
    [id, opts.chainId ?? CHAIN, opts.safeAddress],
  );
  return id;
}

async function insertWalletUser(
  t: TestDb,
  opts: { displayName: string | null; walletAddress: string },
): Promise<string> {
  const res = await t.client.query<{ id: string }>(
    `INSERT INTO users (wallet_address, display_name) VALUES ($1, $2) RETURNING id`,
    [opts.walletAddress, opts.displayName],
  );
  return res.rows[0].id;
}

describe('resolveLabels', () => {
  it('resolves a Magic user via CHECKSUMMED safe_address against a lowercase actor (the casing regression)', async () => {
    const t = await freshDb();
    await insertMagicUser(t, {
      displayName: 'satoshi',
      safeAddress: SAFE_CHECKSUMMED, // stored checksummed, as prod does
    });

    const labels = await resolveLabels(t.db as never, [SAFE_LOWER], CHAIN);
    expect(labels.get(SAFE_LOWER)).toEqual({
      displayName: 'satoshi',
      avatarUrl: null,
      branch: 'safe',
    });
  });

  it('resolves an external-wallet user via wallet_address', async () => {
    const t = await freshDb();
    await insertWalletUser(t, {
      displayName: 'walletguy',
      walletAddress: WALLET_LOWER,
    });

    const labels = await resolveLabels(t.db as never, [WALLET_LOWER], CHAIN);
    expect(labels.get(WALLET_LOWER)?.displayName).toBe('walletguy');
    expect(labels.get(WALLET_LOWER)?.branch).toBe('wallet');
  });

  it('normalizes mixed-case input addresses', async () => {
    const t = await freshDb();
    await insertMagicUser(t, {
      displayName: 'satoshi',
      safeAddress: SAFE_CHECKSUMMED,
    });

    // Caller passes the checksummed form; map is keyed lowercase.
    const labels = await resolveLabels(
      t.db as never,
      [SAFE_CHECKSUMMED],
      CHAIN,
    );
    expect(labels.get(SAFE_LOWER)?.displayName).toBe('satoshi');
  });

  it('omits unknown addresses and null display names (UI falls back to truncation)', async () => {
    const t = await freshDb();
    await insertMagicUser(t, {
      displayName: null, // account exists, never set a name
      safeAddress: SAFE_CHECKSUMMED,
    });

    const labels = await resolveLabels(
      t.db as never,
      [SAFE_LOWER, WALLET_LOWER],
      CHAIN,
    );
    expect(labels.has(SAFE_LOWER)).toBe(false);
    expect(labels.has(WALLET_LOWER)).toBe(false);
  });

  it('prefers the safe branch when both branches match with names', async () => {
    const t = await freshDb();
    // Pathological but possible: one user's wallet_address equals
    // another user's safe address.
    await insertMagicUser(t, {
      displayName: 'safeguy',
      safeAddress: SAFE_CHECKSUMMED,
    });
    await insertWalletUser(t, {
      displayName: 'impostor',
      walletAddress: SAFE_LOWER,
    });

    const labels = await resolveLabels(t.db as never, [SAFE_LOWER], CHAIN);
    expect(labels.get(SAFE_LOWER)).toEqual({
      displayName: 'safeguy',
      avatarUrl: null,
      branch: 'safe',
    });
  });

  it('prefers a display-name-bearing row over a bare higher-precedence branch', async () => {
    const t = await freshDb();
    await insertMagicUser(t, {
      displayName: null, // safe branch, but bare
      safeAddress: SAFE_CHECKSUMMED,
    });
    await insertWalletUser(t, {
      displayName: 'named', // wallet branch, named
      walletAddress: SAFE_LOWER,
    });

    const labels = await resolveLabels(t.db as never, [SAFE_LOWER], CHAIN);
    expect(labels.get(SAFE_LOWER)).toEqual({
      displayName: 'named',
      avatarUrl: null,
      branch: 'wallet',
    });
  });

  it('scopes the safe branch to the chain', async () => {
    const t = await freshDb();
    await insertMagicUser(t, {
      displayName: 'satoshi',
      safeAddress: SAFE_CHECKSUMMED,
      chainId: 99999, // some other chain's safe
    });

    const labels = await resolveLabels(t.db as never, [SAFE_LOWER], CHAIN);
    expect(labels.has(SAFE_LOWER)).toBe(false);
  });

  it('never exposes email in the resolved shape', async () => {
    const t = await freshDb();
    await insertMagicUser(t, {
      displayName: 'satoshi',
      safeAddress: SAFE_CHECKSUMMED,
    });

    const labels = await resolveLabels(t.db as never, [SAFE_LOWER], CHAIN);
    const entry = labels.get(SAFE_LOWER)!;
    expect(Object.keys(entry).sort()).toEqual(['avatarUrl', 'branch', 'displayName']);
  });

  it('handles an empty input without touching the DB', async () => {
    const t = await freshDb();
    const labels = await resolveLabels(t.db as never, [], CHAIN);
    expect(labels.size).toBe(0);
  });

describe('resolveLabels: profile photos are served only when this app uploaded them for that user', () => {
  const HOST = 'store123.public.blob.vercel-storage.com';
  const saved = process.env.BLOB_READ_WRITE_TOKEN;
  beforeEach(() => {
    process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_store123_testsecret';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = saved;
  });
  const setAvatar = (t: TestDb, id: string, url: string | null) => t.client.query('UPDATE users SET avatar_url = $1 WHERE id = $2', [url, id]);

  it("returns the app's own upload for that user", async () => {
    const t = await freshDb();
    const id = await insertMagicUser(t, { displayName: 'kemi', safeAddress: SAFE_CHECKSUMMED });
    const url = `https://${HOST}/avatars/${id}/1790000000000.webp`;
    await setAvatar(t, id, url);
    // The public gets the /api/avatar path, never the stored URL (it carries the internal id); the route reads the stored one.
    expect((await resolveLabels(t.db as never, [SAFE_LOWER], CHAIN)).get(SAFE_LOWER)).toEqual({ displayName: 'kemi', avatarUrl: publicAvatarPath(SAFE_LOWER, url), branch: 'safe' });
    expect((await resolveStoredIdentities(t.db as never, [SAFE_LOWER], CHAIN)).get(SAFE_LOWER)?.avatarUrl).toBe(url);
  });

  it('a user with a photo but no display name is still returned (name null), so the board can show the photo', async () => {
    const t = await freshDb();
    const id = await insertMagicUser(t, { displayName: null, safeAddress: SAFE_CHECKSUMMED });
    const url = `https://${HOST}/avatars/${id}/1.webp`;
    await setAvatar(t, id, url);
    expect((await resolveLabels(t.db as never, [SAFE_LOWER], CHAIN)).get(SAFE_LOWER)).toEqual({ displayName: null, avatarUrl: publicAvatarPath(SAFE_LOWER, url), branch: 'safe' });
  });

  it.each([
    ['a legacy pasted URL on any host', (id: string) => `https://example.com/avatars/${id}/x.webp`],
    ["another Blob store (anyone can create one)", (id: string) => `https://attacker.public.blob.vercel-storage.com/avatars/${id}/x.webp`],
    ["this store, but another user's path", () => `https://${HOST}/avatars/00000000-0000-0000-0000-000000000000/x.webp`],
    ['plain http', (id: string) => `http://${HOST}/avatars/${id}/x.webp`],
  ])('never serves %s', async (_name, urlFor) => {
    const t = await freshDb();
    const id = await insertMagicUser(t, { displayName: 'kemi', safeAddress: SAFE_CHECKSUMMED });
    await setAvatar(t, id, urlFor(id));
    expect((await resolveLabels(t.db as never, [SAFE_LOWER], CHAIN)).get(SAFE_LOWER)?.avatarUrl).toBeNull();
  });

  it("fails closed with no Blob token (the app's own host is unknown): no photo, the name still resolves", async () => {
    delete process.env.BLOB_READ_WRITE_TOKEN;
    const t = await freshDb();
    const id = await insertMagicUser(t, { displayName: 'kemi', safeAddress: SAFE_CHECKSUMMED });
    await setAvatar(t, id, `https://${HOST}/avatars/${id}/1.webp`);
    expect((await resolveLabels(t.db as never, [SAFE_LOWER], CHAIN)).get(SAFE_LOWER)).toEqual({ displayName: 'kemi', avatarUrl: null, branch: 'safe' });
  });

  it('a user with neither a name nor an owned photo is absent (the board falls back to the address and letter)', async () => {
    const t = await freshDb();
    const id = await insertMagicUser(t, { displayName: null, safeAddress: SAFE_CHECKSUMMED });
    await setAvatar(t, id, 'https://example.com/x.png');
    expect((await resolveLabels(t.db as never, [SAFE_LOWER], CHAIN)).has(SAFE_LOWER)).toBe(false);
  });
});
});
