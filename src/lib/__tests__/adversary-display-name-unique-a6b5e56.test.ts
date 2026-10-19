// (Adversary on a6b5e56; fixed in the next commit: a trigger keeps the key with the shown name; run-together reserved words.) ----------------------------------------------------------------------------
// src/lib/__tests__/adversary-display-name-unique-a6b5e56.test.ts
//
// Adversary pass on unique display names (a6b5e56). Owner spec (Joshua 2026-10-17): "two users must not be able to
// have the same display name", compared case-insensitively; "a small reserved list so nobody poses as the platform".
// docs/db-migration-policy.md runs the migration before the app ships, and Preview and Production share one DB, so the
// previous save route (f1af01c, SET display_name only, no check) keeps serving after 0017.
//
// 1. Old app writes AFTER the new one: the new app keys "Bob" for D, then the old route sets C's display_name to
//    "bob". Nothing in the database ties display_name to its key, so the write lands and two accounts show one name.
//    A trigger in the migration (key := normalized display_name on every write) would make the old route's write fail
//    on the unique index instead; the test asserts only that one account shows the name.
// 2. isReservedDisplayName's own rule (src/lib/display-name.ts: "a name made only of the platform's name and role
//    words") misses a run-together brand word followed by TWO role words: "MakoSupportTeam" is allowed while
//    "Mako Support Team" and "MakoSupport" are reserved.
//
// Real migrations 0000..0017 on PGlite, real save route of a6b5e56; only session and CSRF stubbed. The old route's
// write is reproduced as f1af01c issues it (update users set display_name, the schema it knows has no key column).
// ----------------------------------------------------------------------------
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import { isReservedDisplayName } from '@/lib/display-name';

const state = vi.hoisted(() => ({ db: null as unknown, session: null as unknown }));

vi.mock('server-only', () => ({}));
vi.mock('@/db/client', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('@/lib/csrf', () => ({ checkSameOrigin: () => ({ ok: true }) }));
vi.mock('@/lib/user-session', () => ({ getUserSession: async () => state.session }));

import { POST as save } from '../../app/api/user/profile/update/route';

const DIR = join(__dirname, '../../db/migrations');
const journal = JSON.parse(readFileSync(join(DIR, 'meta/_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] };
const apply = async (pg: PGlite, tag: string) => {
  for (const stmt of readFileSync(join(DIR, `${tag}.sql`), 'utf8').split('--> statement-breakpoint')) if (stmt.trim()) await pg.exec(stmt);
};

let pg: PGlite;
const wallets: Record<string, string> = {};
const ids: Record<string, string> = {};
const addUser = async (label: string, n: number, createdAt: string) => {
  wallets[label] = `0x${n.toString(16).padStart(40, '0')}`;
  const r = await pg.query<{ id: string }>(
    `INSERT INTO users (wallet_address, auth_type, display_name, created_at) VALUES ($1, 'wallet', NULL, $2) RETURNING id`,
    [wallets[label], createdAt],
  );
  ids[label] = r.rows[0].id;
};
const as = (label: string) => {
  state.session = { userId: ids[label], authType: 'wallet', walletAddress: wallets[label], sessionId: `00000000-0000-4000-8000-${label.charCodeAt(0).toString(16).padStart(12, '0')}` };
};

beforeAll(async () => {
  pg = new PGlite();
  for (const e of journal.entries) if (e.idx <= 17) await apply(pg, e.tag);
  await addUser('C', 3, '2026-10-02T00:00:00Z');
  await addUser('D', 4, '2026-10-03T00:00:00Z');
  state.db = drizzle(pg, { schema });
}, 60_000);
afterAll(async () => pg.close());

describe('the previous app version writes after the new one', () => {
  it('cannot leave two accounts showing one name', async () => {
    as('D');
    const res = await save(new Request('http://localhost/api/user/profile/update', { method: 'POST', body: JSON.stringify({ displayName: 'Bob' }) }));
    expect(res.status).toBe(200);

    // f1af01c's save route, still serving, sets C's name with no check and no key.
    let oldWrite = 'ok';
    try {
      await pg.query(`UPDATE users SET display_name = $1 WHERE id = $2`, ['bob', ids.C]);
    } catch {
      oldWrite = 'refused';
    }

    const holders = await pg.query<{ id: string }>(`SELECT id FROM users WHERE lower(display_name) = 'bob'`);
    expect({ oldWrite, holders: holders.rows.length }).toMatchObject({ holders: 1 });
  });
});

describe('reserved names', () => {
  it('a run-together brand word with two role words is reserved like its spaced form', () => {
    expect(isReservedDisplayName('Mako Support Team')).toBe(true);
    expect(isReservedDisplayName('MakoSupport')).toBe(true);
    expect(isReservedDisplayName('MakoSupportTeam')).toBe(true);
  });
});
