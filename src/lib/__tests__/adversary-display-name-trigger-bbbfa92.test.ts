// (Adversary on bbbfa92; fixed in the next commit: the trigger also refuses a name a key-less account shows.) ----------------------------------------------------------------------------
// src/lib/__tests__/adversary-display-name-trigger-bbbfa92.test.ts
//
// Adversary pass on unique display names (bbbfa92: migration 0017 trigger keeps display_name_key = key(display_name)).
// Owner spec (Joshua 2026-10-17): "two users must not be able to have the same display name"; accounts that already
// shared a name before the change: "the first to have set it keeps it, the others must pick a new name"; the previous
// app (f1af01c) keeps serving on the same database after the migration.
//
// A grandfathered account (shared a name before 0017, not its oldest holder) keeps showing the name with a NULL key.
// The unique index only sees keys, so once the keyed holder renames, nothing in the database stops the previous app
// (SET display_name only, no holder check) from giving that same name to a THIRD account: two accounts now show one
// name, and the newcomer did not share it before 0017. The new route refuses this (nameHeldByOther compares shown
// names), the database does not.
//
// Real migrations 0000..0017 on PGlite, real save route of bbbfa92; only session and CSRF stubbed. The old route's
// write is reproduced as f1af01c issues it (update users set display_name = trimmed name where id = caller).
// ----------------------------------------------------------------------------
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';

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

beforeAll(async () => {
  pg = new PGlite();
  // Before 0017: A and B already share "Bob" (A first); C has no name.
  for (const e of journal.entries) if (e.idx < 17) await apply(pg, e.tag);
  await addUser('A', 1, 'Bob', '2026-10-01T00:00:00Z');
  await addUser('B', 2, 'bob', '2026-10-02T00:00:00Z');
  await addUser('C', 3, null, '2026-10-03T00:00:00Z');
  await apply(pg, '0017_display_name_key');
  state.db = drizzle(pg, { schema });
}, 60_000);
afterAll(async () => pg.close());

describe('grandfathered name after its keyed holder renames', () => {
  it('the previous app cannot give a name still shown by a grandfathered account to a third account', async () => {
    const before = await pg.query<{ id: string; display_name_key: string | null }>(`SELECT id, display_name_key FROM users WHERE id = $1`, [ids.B]);
    expect(before.rows[0].display_name_key).toBeNull(); // B is grandfathered: shows "bob", no key

    // A, the first holder, renames on the new app.
    as('A');
    const res = await save(new Request('http://localhost/api/user/profile/update', { method: 'POST', body: JSON.stringify({ displayName: 'Alice' }) }));
    expect(res.status).toBe(200);

    // The new app refuses C taking "BOB" while B still shows it.
    as('C');
    const viaNew = await save(new Request('http://localhost/api/user/profile/update', { method: 'POST', body: JSON.stringify({ displayName: 'BOB' }) }));
    expect(viaNew.status).toBe(409);

    // f1af01c's save route, still serving on the same database, sets C's name with no holder check.
    let oldWrite = 'ok';
    try {
      await pg.query(`UPDATE users SET display_name = $1 WHERE id = $2`, ['BOB', ids.C]);
    } catch {
      oldWrite = 'refused';
    }

    const showing = await pg.query<{ id: string }>(`SELECT id FROM users WHERE lower(display_name) = 'bob' ORDER BY created_at`);
    // C never shared "bob" before 0017, so C must not end up showing it next to B.
    expect({ oldWrite, showing: showing.rows.map((r) => r.id) }).toEqual({ oldWrite: 'refused', showing: [ids.B] });
  });
});
