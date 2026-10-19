// GET /api/avatar/<address>/<version> (Joshua 2026-10-17, Codex PUBLIC_PROFILE R1 M2): streams an account's own
// uploaded photo by public address, so the stored URL (whose path carries the internal id) is never sent. One canonical
// path per photo version and a site-wide fetch budget (Codex PUBLIC_PROFILE R2 M2, R3 M2), spent only on a real photo
// after a per-visitor limit and the account and version checks (Codex R4 F2, owner decision Q-E). Real route over the
// leaderboard's PGlite harness; the Blob store is a stubbed fetch and the budget store a faithful INCR model.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { avatarVersion } from '@/lib/public-avatar';
import { createTestDb, type TestDb } from './test-db';

let currentDb: unknown;
vi.mock('@/db/client', () => ({
  get db() {
    return currentDb;
  },
}));

// A faithful model of the budget script: INCR the one key (its window starts on the first call), -1 over the cap,
// else the count including this call.
const budget = vi.hoisted(() => {
  const counts = new Map<string, number>();
  const upstash = vi.fn(async (args: (string | number)[]): Promise<unknown> => {
    const [, , , key, , cap] = args;
    const n = (counts.get(String(key)) ?? 0) + 1;
    counts.set(String(key), n);
    return n > Number(cap) ? -1 : n;
  });
  return { counts, upstash };
});
vi.mock('@/lib/envio-budget', () => ({ upstashCommand: budget.upstash }));

const { GET } = await import('@/app/api/avatar/[address]/[version]/route');
const { AVATAR_FETCHES_PER_MINUTE, AVATAR_VISITOR_PER_MINUTE } = await import('@/lib/avatar-budget');

const HOST = 'store123.public.blob.vercel-storage.com';
const SAFE = '0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195';
const SAFE_LOWER = SAFE.toLowerCase();
const WALLET = '0x000000000000000000000000000000000000b22d';
const NOBODY = '0x000000000000000000000000000000000000c33e';
const KEY = 'mako:avatar:fetch';

let t: TestDb | null = null;
let savedToken: string | undefined;
const blob = vi.fn();
const ids: Record<string, string> = {};

beforeEach(async () => {
  savedToken = process.env.BLOB_READ_WRITE_TOKEN;
  process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_store123_secret';
  blob.mockReset();
  budget.counts.clear();
  budget.upstash.mockClear();
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
const get = (address: string, version: string, query = '', ip?: string) =>
  GET(new Request(`http://localhost/api/avatar/${address}/${version}${query}`, { headers: ip ? { 'x-real-ip': ip } : {} }), {
    params: Promise.resolve({ address, version }),
  });
// A syntactically valid address no account has.
const fakeAddress = (i: number) => `0x${i.toString(16).padStart(40, '0')}`;
const image = (bytes = 'PNGDATA', type = 'image/webp') => new Response(bytes, { status: 200, headers: { 'content-type': type } });

describe('GET /api/avatar/<address>/<version>', () => {
  it("streams the account's own photo at its canonical path, cached a minute at most", async () => {
    await setPhoto('email', photoOf('email'));
    blob.mockResolvedValueOnce(image());
    const res = await get(SAFE_LOWER, avatarVersion(photoOf('email')));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('PNGDATA');
    expect(res.headers.get('content-type')).toBe('image/webp');
    // Never a long cache: a removed photo must stop being served (Joshua 2026-10-17).
    expect(res.headers.get('cache-control')).toBe('public, max-age=60, s-maxage=60');
    expect(res.headers.get('location')).toBeNull(); // streamed, never redirected to the stored URL
    expect(blob).toHaveBeenCalledWith(photoOf('email'));
    expect(budget.counts.get(KEY)).toBe(1);
  });

  it('only the current version is served: an old (replaced) or made-up version is a 404 with no Blob fetch', async () => {
    await setPhoto('wallet', `https://${HOST}/avatars/${ids.wallet}/old.webp`);
    const old = avatarVersion(`https://${HOST}/avatars/${ids.wallet}/old.webp`);
    await setPhoto('wallet', photoOf('wallet')); // replaced
    for (const v of [old, '000000000000']) expect((await get(WALLET, v)).status, v).toBe(404);
    expect(blob).not.toHaveBeenCalled();
  });

  it('a removed photo is a 404 at once; so are no account, a photo on another host, or a non-image reply', async () => {
    await setPhoto('wallet', photoOf('wallet'));
    blob.mockResolvedValueOnce(image());
    expect((await get(WALLET, avatarVersion(photoOf('wallet')))).status).toBe(200);
    await setPhoto('wallet', null); // removed
    expect((await get(WALLET, avatarVersion(photoOf('wallet')))).status).toBe(404);
    blob.mockClear();
    expect((await get(NOBODY, '000000000000')).status).toBe(404); // not a Mako Market account
    expect((await get(SAFE_LOWER, '000000000000')).status).toBe(404); // account without a photo
    // Each with the version of what is stored, so the 404 comes from the host and path checks, not a wrong version.
    for (const stored of ['https://attacker.example/x.png', `https://${HOST}/avatars/${ids.email}/a.webp`]) {
      await setPhoto('wallet', stored);
      expect((await get(WALLET, avatarVersion(stored))).status, stored).toBe(404);
    }
    expect(blob).not.toHaveBeenCalled();
    await setPhoto('wallet', photoOf('wallet'));
    const v = avatarVersion(photoOf('wallet'));
    blob.mockResolvedValueOnce(image('<html>', 'text/html'));
    expect((await get(WALLET, v)).status).toBe(404);
    blob.mockResolvedValueOnce(new Response('gone', { status: 404 }));
    expect((await get(WALLET, v)).status).toBe(404);
    expect(blob).toHaveBeenCalledTimes(2);
  });

  it('only the canonical path reaches the budget or the database: any other spelling or any query is a 404 (Codex R3 M2)', async () => {
    await setPhoto('wallet', photoOf('wallet'));
    const v = avatarVersion(photoOf('wallet'));
    currentDb = null; // any query would throw
    const variants: [string, string, string][] = [
      [SAFE, v, ''], // mixed-case address
      [WALLET.toUpperCase().replace('0X', '0x'), v, ''],
      [WALLET, v.toUpperCase(), ''],
      [WALLET, `${v}0`, ''],
      [WALLET, v.slice(0, -1), ''],
      [WALLET, 'zzzzzzzzzzzz', ''],
      [WALLET, v, '?x=1'],
      [WALLET, v, `?v=${v}`],
      [WALLET, v, `?nxtPv=${v}`], // Next rewrites this key to `v` before the route sees it
      [WALLET, v, `?nxtIv=${v}`],
      [WALLET, v, '?&'],
      [WALLET, v, '?='],
      ['kemi', v, ''],
      ['0x123', v, ''],
      [`${WALLET}00`, v, ''],
    ];
    for (const [address, version, query] of variants) {
      const res = await get(address, version, query);
      expect(res.status, `${address}/${version}${query}`).toBe(404);
      expect(res.headers.get('cache-control')).toBe('public, max-age=60, s-maxage=60');
    }
    expect(blob).not.toHaveBeenCalled();
    expect(budget.upstash).not.toHaveBeenCalled();
    expect(budget.counts.size).toBe(0);
  });

  it('the site-wide budget: the last fetch under the cap is served, the next real photo is a 404 with no Blob fetch', async () => {
    await setPhoto('wallet', photoOf('wallet'));
    const v = avatarVersion(photoOf('wallet'));
    budget.counts.set(KEY, AVATAR_FETCHES_PER_MINUTE - 1);
    blob.mockResolvedValueOnce(image());
    expect((await get(WALLET, v)).status).toBe(200);
    blob.mockClear();
    for (let i = 0; i < 3; i++) {
      const res = await get(WALLET, v);
      expect(res.status).toBe(404);
      expect(res.headers.get('cache-control')).toBe('no-store'); // a refusal is never cached for everyone
    }
    expect(blob).not.toHaveBeenCalled();
  });

  it('made-up addresses and wrong versions never spend the shared budget (Codex R4 F2)', async () => {
    await setPhoto('wallet', photoOf('wallet'));
    for (let i = 1; i <= 50; i++) expect((await get(fakeAddress(i), '0123456789ab', '', `10.0.0.${i % 5}`)).status).toBe(404);
    for (let i = 0; i < 20; i++) expect((await get(WALLET, i.toString(16).padStart(12, '0'), '', '10.0.1.1')).status).toBe(404);
    expect((await get(SAFE_LOWER, '0123456789ab', '', '10.0.1.2')).status).toBe(404); // an account with no photo
    expect(budget.counts.has(KEY)).toBe(false);
    expect(blob).not.toHaveBeenCalled();
  });

  it(`each visitor gets ${AVATAR_VISITOR_PER_MINUTE} requests a minute, then 404 with no database query; others are unaffected`, async () => {
    await setPhoto('wallet', photoOf('wallet'));
    const v = avatarVersion(photoOf('wallet'));
    for (let i = 0; i < AVATAR_VISITOR_PER_MINUTE; i++) expect((await get(fakeAddress(i + 1), v, '', '203.0.113.7')).status).toBe(404);
    const db = currentDb;
    currentDb = null; // any query would throw
    const refusedRes = await get(WALLET, v, '', '203.0.113.7');
    expect(refusedRes.status).toBe(404); // even a real photo, for this visitor
    expect(refusedRes.headers.get('cache-control')).toBe('no-store'); // and not cached, so others still get the photo
    currentDb = db;
    blob.mockResolvedValueOnce(image());
    expect((await get(WALLET, v, '', '198.51.100.9')).status).toBe(200);
    // The IP is never stored in the clear.
    expect([...budget.counts.keys()].some((k) => k.includes('203.0.113.7'))).toBe(false);
  });

  it('a real photo is still served after a burst of made-up requests from many other visitors', async () => {
    await setPhoto('email', photoOf('email'));
    // As many made-up requests as the whole shared budget, spread so no visitor hits its own limit.
    for (let i = 0; i < AVATAR_FETCHES_PER_MINUTE + 10; i++) {
      expect((await get(fakeAddress(i + 1), '0123456789ab', '', `192.0.2.${i % 10}`)).status).toBe(404);
    }
    blob.mockResolvedValueOnce(image());
    expect((await get(SAFE_LOWER, avatarVersion(photoOf('email')), '', '198.51.100.20')).status).toBe(200);
    expect(budget.counts.get(KEY)).toBe(1);
  });

  it('the visitor IP: x-real-ip, else the first x-forwarded-for entry; none at all shares one "unknown" bucket', async () => {
    const { visitorIp } = await import('@/lib/avatar-budget');
    const req = (h: Record<string, string>) => new Request('http://localhost/', { headers: h });
    expect(visitorIp(req({ 'x-real-ip': '1.2.3.4', 'x-forwarded-for': '5.6.7.8' }))).toBe('1.2.3.4');
    expect(visitorIp(req({ 'x-forwarded-for': ' 5.6.7.8 , 9.9.9.9' }))).toBe('5.6.7.8');
    expect(visitorIp(req({}))).toBe('unknown');
  });

  it('the budget store down or answering nonsense: 404 with no database query and no fetch, never unlimited', async () => {
    await setPhoto('wallet', photoOf('wallet'));
    const v = avatarVersion(photoOf('wallet'));
    currentDb = null; // any query would throw
    budget.upstash.mockRejectedValueOnce(new Error('unreachable'));
    const down = await get(WALLET, v);
    expect(down.status).toBe(404);
    expect(down.headers.get('cache-control')).toBe('no-store');
    for (const reply of ['OK', 0, 1.5, null, AVATAR_FETCHES_PER_MINUTE + 1, '1']) {
      budget.upstash.mockResolvedValueOnce(reply);
      expect((await get(WALLET, v)).status, String(reply)).toBe(404);
    }
    expect(blob).not.toHaveBeenCalled();
  });
});
