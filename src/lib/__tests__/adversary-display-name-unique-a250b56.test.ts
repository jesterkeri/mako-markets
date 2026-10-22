// (Adversary on a250b56; fixed in the next commit: names still shown without a key count as taken.) ----------------------------------------------------------------------------
// src/lib/__tests__/adversary-display-name-unique-a250b56.test.ts
//
// Adversary pass on unique display names (a250b56). Owner spec (Joshua 2026-10-17): "two users must not be able to
// have the same display name", compared case-insensitively; accounts that already shared a name before the change keep
// showing it until they next edit.
//
// Migration 0017 gives only the oldest holder of a shared name a key; later duplicates keep their name with a NULL key.
// Once the oldest holder renames, the key is free, and a THIRD account can save the same name through the real save
// route while the grandfathered duplicate still shows it: a new duplicate created after the change.
//
// Real migrations 0000..0017 on PGlite, real save and availability routes; only the session and CSRF are stubbed.
// ----------------------------------------------------------------------------
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';

const state = vi.hoisted(() => ({ db: null as unknown, session: null as unknown }));

// (Builder: the per-account name-check cap, Codex UNIQUE_NAMES R1 M2, is its own test; here it always allows.)
vi.mock('@/lib/name-check-budget', () => ({ reserveSessionCheck: async () => 'ok', reserveSiteCheck: async () => 'ok' }));
vi.mock('server-only', () => ({}));
vi.mock('@/db/client', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('@/lib/csrf', () => ({ checkSameOrigin: () => ({ ok: true }) }));
vi.mock('@/lib/user-session', () => ({ getUserSession: async () => state.session }));

import { POST as save } from '../../app/api/user/profile/update/route';
import { GET as available } from '../../app/api/user/profile/name-available/route';

const DIR = join(__dirname, '../../db/migrations');
const journal = JSON.parse(readFileSync(join(DIR, 'meta/_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] };
const apply = async (pg: PGlite, tag: string) => {
  for (const stmt of readFileSync(join(DIR, `${tag}.sql`), 'utf8').split('--> statement-breakpoint')) if (stmt.trim()) await pg.exec(stmt);
};

let pg: PGlite;
const wallets: Record<string, string> = {};
const ids: Record<string, string> = {};
const addUser = async (label: string, n: number, name: string | null, createdAt: string) => {
  wallets[label] = `0x${n.toString(16).padStart(40, '0')}`;
  const r = await pg.query<{ id: string }>(
    `INSERT INTO users (wallet_address, auth_type, display_name, created_at) VALUES ($1, 'wallet', $2, $3) RETURNING id`,
    [wallets[label], name, createdAt],
  );
  ids[label] = r.rows[0].id;
};
const as = (label: string) => {
  state.session = { userId: ids[label], authType: 'wallet', walletAddress: wallets[label], sessionId: `00000000-0000-4000-8000-${label.charCodeAt(0).toString(16).padStart(12, '0')}` };
};
const saveName = async (displayName: string) => {
  const res = await save(new Request('http://localhost/api/user/profile/update', { method: 'POST', body: JSON.stringify({ displayName }) }));
  return { status: res.status, body: (await res.json()) as { error?: string; displayName?: string } };
};

beforeAll(async () => {
  pg = new PGlite();
  for (const e of journal.entries) if (e.idx < 17) await apply(pg, e.tag);
  // Production before 0017: two accounts already share "Jo" (A is the oldest).
  await addUser('A', 1, 'Jo', '2026-10-01T00:00:00Z');
  await addUser('B', 2, 'jo', '2026-10-02T00:00:00Z');
  await apply(pg, '0017_display_name_key');
  // After 0017: a new account C signs up with no name.
  await addUser('C', 3, null, '2026-10-18T00:00:00Z');
  state.db = drizzle(pg, { schema });
}, 60_000);
afterAll(async () => pg.close());

describe('a grandfathered duplicate still shows its name, so nobody new may take it', () => {
  it('after the oldest holder renames, a third account cannot save the name B still shows', async () => {
    as('A');
    expect((await saveName('Alpha')).status).toBe(200);

    const shown = (await pg.query<{ display_name: string }>(`SELECT display_name FROM users WHERE id = $1`, [ids.B])).rows[0];
    expect(shown.display_name).toBe('jo'); // B never edited: it keeps showing "jo", as the spec allows

    as('C');
    const check = await available(new Request('http://localhost/api/user/profile/name-available?name=JO'));
    const res = await saveName('JO');

    const same = await pg.query<{ id: string }>(`SELECT id FROM users WHERE lower(display_name) = 'jo'`);
    // The spec: two users must not have the same display name. B and C must not both be "jo".
    expect({ live: await check.json(), save: res.status, holders: same.rows.length }).toEqual({
      live: { available: false, reason: 'taken' },
      save: 409,
      holders: 1,
    });
  });
});

describe('control: the index refusal reaches the user as 409 name_taken', () => {
  it('C cannot take "alpha" from A (case and spacing differ)', async () => {
    as('C');
    expect(await saveName('  ALPHA ')).toEqual({ status: 409, body: { error: 'name_taken' } });
  });
});
